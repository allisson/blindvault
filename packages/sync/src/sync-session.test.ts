// The sync session messages (`sync-protocol.md` §5, §11, CRYPTO-INV-009, D218): after `Noise_KK`,
// every message travels framed in the Noise channel, decoded strictly, and `abort` ends the session
// on both sides with its reason.

import { Keyring, generateDeviceIdentity, initCrypto } from '@blindvault/crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import vectors from '../test-vectors/sync-v1.json' with { type: 'json' };
import { toFrames } from './frames';
import { type Direction, type MemoryPairOptions, memoryPair } from './memory';
import { encodeMessage } from './messages';
import { encodeSyncMessage, type SyncMessage } from './sync-messages';
import { syncHandshake } from './sync-handshake';
import { SyncError, SyncSession } from './sync-session';

beforeAll(initCrypto);

const hex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const payload = (fill: number) => ({
  message: new Uint8Array(140).fill(fill),
  fingerprint: new Uint8Array(32).fill(fill + 1),
});

/**
 * Two sessions after a real `Noise_KK` over the in-memory link. `after` sees each message sent
 * once the two handshake messages went through, `raw` sends on the link under the channel.
 */
async function sessions(
  after?: (direction: Direction, message: Uint8Array) => readonly Uint8Array[],
) {
  let handshake = 0;
  const options: MemoryPairOptions = {
    intercept: (direction, message) =>
      handshake++ < 2 || !after ? [message] : after(direction, message),
  };
  const link = memoryPair(options);
  const keyring = new Keyring();
  const a = generateDeviceIdentity(keyring);
  const b = generateDeviceIdentity(keyring);
  const both = { initiator: payload(0x10), responder: payload(0x30) };
  const [i, r] = await Promise.all([
    syncHandshake(link.a, { role: 'initiator', identity: a, peerPublicKey: b.publicKey, ...both }),
    syncHandshake(link.b, { role: 'responder', identity: b, peerPublicKey: a.publicKey, ...both }),
  ]);
  // `bChannel`: b's Noise channel, to send what b's session would refuse to.
  return {
    link,
    a: new SyncSession(i.channel),
    b: new SyncSession(r.channel),
    bChannel: r.channel,
  };
}

async function failure(promise: Promise<unknown>): Promise<[string, string]> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SyncError) return [error.reason, error.by];
    throw error;
  }
  throw new Error('expected the session to end');
}

const entry = {
  recordFormatVersion: 1,
  recordType: 1,
  recordId: new Uint8Array(16).fill(5),
  hlc: { physicalMs: 1_700_000_000_000, counter: 2, deviceId: new Uint8Array(16).fill(6) },
  deleted: false,
  keyEpoch: 1,
};

describe('sync session (sync-protocol.md §11, CRYPTO-INV-009)', () => {
  it('carries every message type both ways, in order, after Noise_KK', async () => {
    const { a, b } = await sessions();
    const messages: SyncMessage[] = [
      { t: 'summary-begin', count: 1 },
      { t: 'summary', e: [entry] },
      { t: 'summary-end' },
      { t: 'records-begin', count: 1 },
      { t: 'record', r: new Uint8Array(40).fill(4) },
      { t: 'records-end' },
      { t: 'committed' },
      { t: 'retired', r: new Uint8Array(40).fill(8) },
    ];
    for (const message of messages) await a.send(message);
    for (const message of messages) expect(await b.receive()).toEqual(message);
    await b.send({ t: 'committed' });
    expect(await a.receive()).toEqual({ t: 'committed' });
  });

  it('sends every message inside the Noise channel: no frame carries its plaintext', async () => {
    const seen: Uint8Array[] = [];
    const { a, b } = await sessions((_d, m) => {
      seen.push(m);
      return [m];
    });
    const record = new Uint8Array(40).fill(0x5a);
    await a.send({ t: 'record', r: record });
    expect(await b.receive()).toEqual({ t: 'record', r: record });
    const plain = toFrames(encodeSyncMessage({ t: 'record', r: record }))[0];
    expect(seen).toHaveLength(1);
    // The channel message is the frame sealed: 16 bytes of tag more, and none of its bytes in clear.
    expect(seen[0]?.length).toBe((plain?.length ?? 0) + 16);
    expect(Buffer.from(seen[0] ?? []).includes(Buffer.from(record))).toBe(false);
  });

  it.each([
    ['ended', 'ended'],
    ['locked', 'locked'],
    ['expired', 'expired'],
    ['retired-peer', 'retired-peer'],
    ['verification-failed', 'verification-failed'],
  ] as const)('sends abort with %s, and both sides end with it', async (_case, reason) => {
    const { a, b, link } = await sessions();
    const error = await a.abort(reason);
    expect([error.reason, error.by]).toEqual([reason, 'local']);
    expect(await failure(b.receive())).toEqual([reason, 'remote']);
    expect(await link.a.closed).toBe('local');
    expect(await failure(a.send({ t: 'committed' }))).toEqual([reason, 'local']);
  });

  it('ends on an abort that arrives while no one reads', async () => {
    const { a, b } = await sessions();
    await a.abort('locked');
    expect(await b.ended).toMatchObject({ reason: 'locked', by: 'remote' });
  });

  it.each([
    ['a pairing message', encodeMessage({ t: 'confirmed' }), 'protocol-error'],
    ['a pairing abort reason', encodeMessage({ t: 'abort', reason: 'cancelled' }), 'abort'],
    [
      'a message of another version',
      hex(vectors.messages.invalid.find((c) => c.case === 'v 2')?.bytes ?? ''),
      'version',
    ],
    [
      'a summary with an entry out of range',
      hex(vectors.messages.invalid.find((c) => c.case === 'keyEpoch over 2^32 - 1')?.bytes ?? ''),
      'protocol-error',
    ],
  ] as const)('aborts on %s inside the channel, telling the peer', async (_case, bytes, reason) => {
    // b's session would refuse to send it: the frames go through b's Noise channel as they are.
    const { a, b, bChannel } = await sessions();
    for (const frame of toFrames(bytes)) await bChannel.send(frame);
    if (reason === 'abort') {
      // A reason sync does not know reads as protocol-error, from the peer.
      expect(await failure(a.receive())).toEqual(['protocol-error', 'remote']);
      return;
    }
    expect(await failure(a.receive())).toEqual([reason, 'local']);
    expect(await failure(b.receive())).toEqual([reason, 'remote']);
  });

  it('ends as closed on a message sent in the clear under the channel', async () => {
    const { a, b, link } = await sessions();
    await link.b.send(toFrames(encodeSyncMessage({ t: 'committed' }))[0] ?? new Uint8Array());
    expect(await failure(a.receive())).toEqual(['closed', 'remote']);
    expect(await failure(b.receive())).toEqual(['closed', 'remote']);
  });

  it('ends as closed on a channel message tampered with', async () => {
    let n = 0;
    const { a, b } = await sessions((_d, m) =>
      n++ === 0 ? [Uint8Array.from(m, (x, i) => (i === 0 ? x ^ 1 : x))] : [m],
    );
    await b.send({ t: 'summary-begin', count: 0 });
    expect(await failure(a.receive())).toEqual(['closed', 'remote']);
  });

  it('ends as closed on a channel message replayed, after the original', async () => {
    const { a, b } = await sessions((_d, m) => [m, m]);
    await b.send({ t: 'summary-begin', count: 0 });
    expect(await a.receive()).toEqual({ t: 'summary-begin', count: 0 });
    expect(await failure(a.receive())).toEqual(['closed', 'remote']);
  });

  it('ends as closed on a channel message dropped, at the next one', async () => {
    let n = 0;
    const { a, b } = await sessions((_d, m) => (n++ === 0 ? [] : [m]));
    await b.send({ t: 'summary-begin', count: 0 });
    await b.send({ t: 'summary-end' });
    expect(await failure(a.receive())).toEqual(['closed', 'remote']);
  });

  it('ends as closed on two channel messages swapped', async () => {
    let held: Uint8Array | undefined;
    const { a, b } = await sessions((_d, m) => {
      if (!held) {
        held = m;
        return [];
      }
      return [m, held];
    });
    await b.send({ t: 'summary-begin', count: 0 });
    await b.send({ t: 'summary-end' });
    expect(await failure(a.receive())).toEqual(['closed', 'remote']);
  });

  it('ends as closed when the link closes or breaks with no abort', async () => {
    const closed = await sessions();
    closed.link.b.close();
    expect(await failure(closed.a.receive())).toEqual(['closed', 'remote']);
    const broken = await sessions();
    broken.link.breakLink();
    await flush();
    expect(await failure(broken.a.send({ t: 'committed' }))).toEqual(['closed', 'remote']);
  });

  it('refuses to send a message the codec rejects, and stays open', async () => {
    const { a, b } = await sessions();
    await expect(a.send({ t: 'summary', e: [] })).rejects.toThrow('message rejected');
    await a.send({ t: 'committed' });
    expect(await b.receive()).toEqual({ t: 'committed' });
  });

  it('names its error', () => {
    const error = new SyncError('ended', 'remote');
    expect(error.message).toBe('sync session ended (ended, remote)');
    expect(error.name).toBe('SyncError');
  });
});

describe('sends one at a time (D222)', () => {
  it('never interleaves the frames of two messages sent at once', async () => {
    const { a, b } = await sessions();
    const big = new Uint8Array(200_000).fill(0x42);
    await Promise.all([
      a.send({ t: 'record', r: big }),
      a.send({ t: 'committed' }),
      a.send({ t: 'record', r: Uint8Array.of(7) }),
    ]);
    expect(await b.receive()).toEqual({ t: 'record', r: big });
    expect(await b.receive()).toEqual({ t: 'committed' });
    expect(await b.receive()).toEqual({ t: 'record', r: Uint8Array.of(7) });
  });

  it('retires the peer with its record then abort, after the message being sent and before any other (§6)', async () => {
    const { a, b } = await sessions();
    const big = new Uint8Array(200_000).fill(0x42);
    const sending = a.send({ t: 'record', r: big });
    const retiring = a.retire(Uint8Array.of(9));
    const after = failure(a.send({ t: 'record', r: Uint8Array.of(1) }));
    await sending;
    expect(await retiring).toMatchObject({ reason: 'retired-peer', by: 'local' });
    expect(await after).toEqual(['retired-peer', 'local']);
    expect(await b.receive()).toEqual({ t: 'record', r: big });
    expect(await b.receive()).toEqual({ t: 'retired', r: Uint8Array.of(9) });
    expect(await failure(b.receive())).toEqual(['retired-peer', 'remote']);
  });
});
