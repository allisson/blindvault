import {
  Keyring,
  generateDeviceIdentity,
  initCrypto,
  pairingCommitment,
  pairingNonce,
  pairingSas,
} from '@blindvault/crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { FrameReader } from './frames';
import { pairingHandshake } from './handshake';
import { type MemoryPairOptions, memoryPair } from './memory';
import { type Message, decodeMessage } from './messages';
import { encodePayload } from './payload';
import { type SasStage, exchangeNonces } from './sas';
import { IDLE_TIMEOUT_MS, PairingError, PairingSession } from './session';

beforeAll(initCrypto);

afterEach(() => {
  vi.useRealTimers();
});

const handshakeHash = new Uint8Array(64).fill(0x50);
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

async function failure(promise: Promise<unknown>): Promise<[string, string]> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PairingError) return [error.reason, error.by];
    throw error;
  }
  throw new Error('expected the session to end');
}

/** Decodes the plaintext messages crossing the link, for the order checks. */
function recorder() {
  const log: { direction: string; message: Message }[] = [];
  const readers = { 'a-to-b': new FrameReader(), 'b-to-a': new FrameReader() };
  const intercept: MemoryPairOptions['intercept'] = (direction, frame) => {
    const bytes = readers[direction].push(frame.slice());
    if (bytes) log.push({ direction, message: decodeMessage(bytes) });
    return [frame];
  };
  return { log, intercept };
}

/** I on side a, R on side b, over a plain memory link (the Noise channel is tested apart). */
function pair(options: MemoryPairOptions & { commitment?: Uint8Array } = {}) {
  const link = memoryPair(options);
  const drawn = pairingNonce();
  const nonce = drawn.nonce.slice();
  const i = new PairingSession(link.a);
  const r = new PairingSession(link.b);
  return {
    link,
    nonce,
    i,
    r,
    stages: () =>
      Promise.allSettled([
        exchangeNonces(i, { role: 'initiator', handshakeHash, nonce: drawn.nonce }),
        exchangeNonces(r, {
          role: 'responder',
          handshakeHash,
          commitment: options.commitment ?? drawn.commitment,
        }),
      ]),
  };
}

function fulfilled(results: PromiseSettledResult<SasStage>[]): [SasStage, SasStage] {
  const [i, r] = results;
  if (i?.status !== 'fulfilled' || r?.status !== 'fulfilled') throw new Error('exchange failed');
  return [i.value, r.value];
}

describe('nonces and SAS (pairing-protocol.md §6)', () => {
  it('shows the same SAS on both sides, from h and both nonces', async () => {
    const { log, intercept } = recorder();
    const { stages, nonce } = pair({ intercept });
    const [i, r] = fulfilled(await stages());
    expect(i.sas).toMatch(/^\d{6}$/);
    expect(r.sas).toBe(i.sas);
    const nonceR = log[0]?.message.t === 'nonce' ? log[0].message.n : new Uint8Array();
    expect(pairingSas(handshakeHash, nonce, nonceR)).toBe(i.sas);
  });

  it('has R send its nonce first, and I reveal its own only after', async () => {
    const { log, intercept } = recorder();
    const { stages, nonce } = pair({ intercept });
    fulfilled(await stages());
    expect(log.map((e) => [e.direction, e.message.t])).toEqual([
      ['b-to-a', 'nonce'],
      ['a-to-b', 'nonce'],
    ]);
    expect(log[1]?.message).toEqual({ t: 'nonce', n: nonce });
  });

  it('draws a new responder nonce each session', async () => {
    const sas = new Set<string>();
    for (let k = 0; k < 4; k++) sas.add(fulfilled(await pair().stages())[1].sas);
    expect(sas.size).toBeGreaterThan(1);
  });

  it('wipes the initiator nonce once used', async () => {
    const link = memoryPair();
    const drawn = pairingNonce();
    await Promise.all([
      exchangeNonces(new PairingSession(link.a), {
        role: 'initiator',
        handshakeHash,
        nonce: drawn.nonce,
      }),
      exchangeNonces(new PairingSession(link.b), {
        role: 'responder',
        handshakeHash,
        commitment: drawn.commitment,
      }),
    ]);
    expect(drawn.nonce.every((b) => b === 0)).toBe(true);
  });

  it('aborts on a nonce that does not open the commitment (protocol-error)', async () => {
    const { stages } = pair({ commitment: pairingCommitment(new Uint8Array(32).fill(9)) });
    const [i, r] = await stages();
    expect(r.status).toBe('rejected');
    if (r.status === 'rejected')
      expect(r.reason).toMatchObject({ reason: 'protocol-error', by: 'local' });
    // I got R's nonce and revealed its own before R refused: its SAS stage ends on R's abort.
    if (i.status !== 'fulfilled') throw new Error('I should reach the SAS');
    expect(await failure(i.value.confirm())).toEqual(['protocol-error', 'remote']);
  });

  it('aborts when a man in the middle replaces the revealed nonce', async () => {
    const forged = new Uint8Array(32).fill(0xee);
    const { stages } = pair({
      intercept: (direction, frame) =>
        direction === 'a-to-b'
          ? [Uint8Array.of(...frame.subarray(0, frame.length - 32), ...forged)]
          : [frame],
    });
    const [, r] = await stages();
    expect(r.status).toBe('rejected');
    if (r.status === 'rejected') expect(r.reason).toMatchObject({ reason: 'protocol-error' });
  });

  it('aborts when I gets something other than a nonce first (protocol-error)', async () => {
    const link = memoryPair();
    const i = new PairingSession(link.a);
    const r = new PairingSession(link.b);
    await r.send({ t: 'confirmed' });
    expect(
      await failure(
        exchangeNonces(i, { role: 'initiator', handshakeHash, nonce: pairingNonce().nonce }),
      ),
    ).toEqual(['protocol-error', 'local']);
    expect(await failure(r.receive())).toEqual(['protocol-error', 'remote']);
  });

  it('aborts when R gets something other than a nonce (protocol-error)', async () => {
    const link = memoryPair();
    const i = new PairingSession(link.a);
    const r = new PairingSession(link.b);
    const exchange = exchangeNonces(r, {
      role: 'responder',
      handshakeHash,
      commitment: pairingNonce().commitment,
    });
    expect((await i.receive()).t).toBe('nonce');
    await i.send({ t: 'master-key', mk: new Uint8Array(32), vid: new Uint8Array(16) });
    expect(await failure(exchange)).toEqual(['protocol-error', 'local']);
  });

  it('ends the exchange when the peer aborts or the link closes', async () => {
    const link = memoryPair();
    const i = new PairingSession(link.a);
    const exchange = exchangeNonces(i, {
      role: 'initiator',
      handshakeHash,
      nonce: pairingNonce().nonce,
    });
    await new PairingSession(link.b).abort('cancelled');
    expect(await failure(exchange)).toEqual(['cancelled', 'remote']);
    const closed = memoryPair();
    const r = exchangeNonces(new PairingSession(closed.b), {
      role: 'responder',
      handshakeHash,
      commitment: pairingNonce().commitment,
    });
    closed.a.close();
    expect(await failure(r)).toEqual(['closed', 'remote']);
  });
});

describe('SAS confirmation (pairing-protocol.md §6.4, D148)', () => {
  it('completes once both devices confirmed, in either order', async () => {
    const { stages, i: si, r: sr } = pair();
    const [i, r] = fulfilled(await stages());
    const iDone = i.confirm();
    await flush();
    await r.confirm();
    await iDone;
    expect(si.error).toBeNull();
    expect(sr.error).toBeNull();
    // The next stage reads the next messages.
    await si.send({ t: 'master-key', mk: new Uint8Array(32).fill(1), vid: new Uint8Array(16) });
    expect((await sr.receive()).t).toBe('master-key');
  });

  it('waits for the peer: one confirmation alone does not complete', async () => {
    const { stages } = pair();
    const [i] = fulfilled(await stages());
    let done = false;
    void i.confirm().then(() => (done = true));
    await flush();
    expect(done).toBe(false);
  });

  it.each(['sas-mismatch', 'cancelled'] as const)(
    'aborts with %s when the user rejects, on both sides',
    async (reason) => {
      const { stages, r: sr } = pair();
      const [i, r] = fulfilled(await stages());
      const waiting = i.confirm();
      await r.reject(reason);
      expect(await failure(waiting)).toEqual([reason, 'remote']);
      expect(sr.error?.reason).toBe(reason);
    },
  );

  it('ends while the SAS is still on screen when the peer aborts', async () => {
    const { stages, i: si, r: sr } = pair();
    fulfilled(await stages());
    await sr.abort('locked');
    expect(await si.ended).toMatchObject({ reason: 'locked', by: 'remote' });
  });

  it('aborts on a master-key or MAC before both confirmations (CRYPTO-INV-011)', async () => {
    for (const early of [
      { t: 'master-key', mk: new Uint8Array(32).fill(1), vid: new Uint8Array(16) },
      { t: 'key-confirmation', mac: new Uint8Array(32) },
    ] as const) {
      const { stages, i: si, r: sr } = pair();
      const [, r] = fulfilled(await stages());
      // A peer that skips the confirmation: B has not confirmed, and refuses the key.
      await si.send(early);
      expect(await sr.ended).toMatchObject({ reason: 'protocol-error', by: 'local' });
      expect(await failure(r.confirm())).toEqual(['protocol-error', 'local']);
      expect(await si.ended).toMatchObject({ reason: 'protocol-error', by: 'remote' });
    }
  });

  it('aborts on a key that arrives after this side confirmed but before the peer did', async () => {
    const { stages, i: si } = pair();
    const [, r] = fulfilled(await stages());
    const waiting = r.confirm();
    await si.send({ t: 'master-key', mk: new Uint8Array(32).fill(1), vid: new Uint8Array(16) });
    expect(await failure(waiting)).toEqual(['protocol-error', 'local']);
  });

  it('takes one answer only', async () => {
    const { stages } = pair();
    const [i, r] = fulfilled(await stages());
    const done = i.confirm();
    await expect(i.confirm()).rejects.toThrow('already answered');
    await expect(i.reject('cancelled')).rejects.toThrow('already answered');
    await r.confirm();
    await done;
  });

  it('starts the 60-second limit once both confirmed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { stages, i: si, r: sr } = pair();
    const [i, r] = fulfilled(await stages());
    await Promise.all([i.confirm(), r.confirm()]);
    const waiting = sr.receive();
    vi.advanceTimersByTime(IDLE_TIMEOUT_MS);
    await flush();
    expect(await failure(waiting)).toEqual(['expired', 'local']);
    expect(await si.ended).toMatchObject({ reason: 'expired', by: 'remote' });
  });
});

describe('after a real handshake', () => {
  it('derives the same SAS on both devices from the Noise channel', async () => {
    const keyring = new Keyring();
    const drawn = pairingNonce();
    const base = {
      sessionId: new Uint8Array(16).fill(0x5a),
      ufrag: 'abcd',
      pwd: 'a'.repeat(22),
      candidates: [{ kind: 'host-ipv4', address: Uint8Array.of(192, 168, 1, 2), port: 5000 }],
      formatVersions: [1],
      recordTypes: [1, 2, 3, 4, 5, 6],
    } as const;
    const payloadInitiator = encodePayload({
      ...base,
      role: 'initiator',
      setup: 'actpass',
      holdsVault: true,
      fingerprint: new Uint8Array(32).fill(0x10),
      commitment: drawn.commitment,
    });
    const payloadResponder = encodePayload({
      ...base,
      role: 'responder',
      setup: 'active',
      holdsVault: false,
      fingerprint: new Uint8Array(32).fill(0x30),
      commitment: null,
    });
    const link = memoryPair();
    const shared = { payloadInitiator, payloadResponder };
    const [hi, hr] = await Promise.all([
      pairingHandshake(link.a, {
        ...shared,
        role: 'initiator',
        identity: generateDeviceIdentity(keyring),
      }),
      pairingHandshake(link.b, {
        ...shared,
        role: 'responder',
        identity: generateDeviceIdentity(keyring),
      }),
    ]);
    const si = new PairingSession(hi.channel);
    const sr = new PairingSession(hr.channel);
    const [i, r] = await Promise.all([
      exchangeNonces(si, {
        role: 'initiator',
        handshakeHash: hi.handshakeHash,
        nonce: drawn.nonce,
      }),
      exchangeNonces(sr, {
        role: 'responder',
        handshakeHash: hr.handshakeHash,
        commitment: drawn.commitment,
      }),
    ]);
    expect(i.sas).toBe(r.sas);
    await Promise.all([i.confirm(), r.confirm()]);
    si.close();
    expect(await sr.ended).toMatchObject({ reason: 'closed', by: 'remote' });
  });
});
