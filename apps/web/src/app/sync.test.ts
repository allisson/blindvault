// The manual sync flow (sync-protocol.md §3 to §5, §12, D215, D216): two flows, each with its own
// identity, over an in-memory link in place of WebRTC. The payload, the delivery and `Noise_KK` are
// tested in `packages/sync`; here, what the screens drive: the texts, the refusals that keep the
// wait going, the handshake (D217), the connection and its end.

import { Keyring, generateDeviceIdentity, initCrypto } from '@blindvault/crypto';
import {
  type ConnectionOptions,
  type LinkFields,
  type MemoryPair,
  type MemoryPairOptions,
  TransportClosedError,
  decodeReconnectionText,
  encodeReconnectionText,
  memoryPair,
} from '@blindvault/sync';
import { type SyncGrant } from '@blindvault/vault';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { type SyncPort, type SyncStage, Syncing } from './sync';

beforeAll(initCrypto);

afterEach(() => {
  vi.useRealTimers();
});

const DESCRIPTION = {
  ufrag: 'abcd',
  pwd: 'a'.repeat(22),
  candidates: [{ kind: 'host-ipv4', address: Uint8Array.of(192, 168, 1, 2), port: 5000 }],
} as const;

/** WebRTC replaced by one in-memory link per session: I's accept opens it for R. */
function network(pairOptions: MemoryPairOptions = {}) {
  let link: { pair: MemoryPair; open: () => void; opened: Promise<void> } | undefined;
  const options: ConnectionOptions[] = [];
  const closed: string[] = [];
  const port: SyncPort = {
    offerLink: (sessionId, connection) => {
      options.push(connection);
      let open!: () => void;
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      const pair = memoryPair(pairOptions);
      link = { pair, open, opened };
      return Promise.resolve({
        link: {
          role: 'initiator',
          setup: 'actpass',
          fingerprint: new Uint8Array(32).fill(0x10),
          ...DESCRIPTION,
          sessionId: sessionId.slice(),
        },
        accept: () => {
          open();
          return Promise.resolve(pair.a);
        },
        close: () => {
          closed.push('i');
          pair.a.close();
        },
      });
    },
    answerLink: (offer, connection) => {
      options.push(connection);
      if (!link) return Promise.reject(new Error('no session'));
      const { pair, opened } = link;
      return Promise.resolve({
        link: {
          role: 'responder',
          setup: 'active',
          fingerprint: new Uint8Array(32).fill(0x30),
          ...DESCRIPTION,
          sessionId: offer.sessionId.slice(),
        },
        transport: opened.then(() => pair.b),
        close: () => {
          closed.push('r');
          pair.b.close();
        },
      });
    },
  };
  return { port, options, closed, pair: () => link?.pair };
}

const VAULT = new Uint8Array(16).fill(0x42);

function devices() {
  const identities = {
    i: generateDeviceIdentity(new Keyring()),
    r: generateDeviceIdentity(new Keyring()),
    other: generateDeviceIdentity(new Keyring()),
  };
  const grant = (self: keyof typeof identities, peer: keyof typeof identities): SyncGrant => ({
    identity: identities[self],
    vaultId: VAULT,
    peerPublicKey: identities[peer].publicKey,
    peerDeviceId: identities[peer].deviceId,
    peerName: peer,
  });
  return { identities, grant };
}

function flows(net = network(), sameNetwork = true) {
  const { grant } = devices();
  const make = (role: 'initiator' | 'responder', g: SyncGrant) =>
    new Syncing({
      port: net.port,
      sameNetwork,
      stun: { kind: 'default' },
      grant: g,
      role,
      onChange: () => undefined,
    });
  const i = make('initiator', grant('i', 'r'));
  const r = make('responder', grant('r', 'i'));
  // A third device of the vault, whose payloads are sealed to R.
  const other = make('initiator', grant('other', 'r'));
  return { i, r, other, net, grant, make };
}

async function stage(flow: Syncing, kind: SyncStage['kind']): Promise<SyncStage> {
  await vi.waitFor(() => {
    expect(flow.stage.kind).toBe(kind);
  });
  return flow.stage;
}

function textOf(s: SyncStage): string {
  if (s.kind !== 'offer' && s.kind !== 'answer') throw new Error(`no text: ${s.kind}`);
  return s.text;
}

/** I shows its offer, R takes it and shows its answer. */
async function exchanged(net = network()) {
  const f = flows(net);
  f.i.begin();
  f.r.begin();
  const offer = textOf(await stage(f.i, 'offer'));
  expect(f.r.stage.kind).toBe('scan');
  expect(await f.r.submit(offer)).toBe('ok');
  const answer = textOf(await stage(f.r, 'answer'));
  return { ...f, offer, answer };
}

describe('manual sync flow (sync-protocol.md §3 to §5, D216)', () => {
  it('connects I and R from the two texts, with no STUN server on the same network only', async () => {
    const sent: [string, number][] = [];
    const { i, r, net, answer } = await exchanged(
      network({
        intercept: (direction, message) => {
          sent.push([direction, message.length]);
          return [message];
        },
      }),
    );
    expect(await i.submit(answer)).toBe('ok');
    await stage(i, 'connected');
    await stage(r, 'connected');
    expect(net.options.map((o) => o.iceServers)).toEqual([[], []]);
    // Nothing but the two Noise_KK messages is sent (CRYPTO-INV-008, D217).
    expect(sent).toEqual([
      ['a-to-b', 48],
      ['b-to-a', 48],
    ]);
    expect(await i.submit(answer)).toBe('unavailable');
  });

  it('fails as unverified when the peer does not complete Noise_KK, sending nothing else (D217)', async () => {
    let seen = 0;
    const sent: number[] = [];
    const { i, r, answer } = await exchanged(
      network({
        // A changed byte in I's first handshake message: R refuses it, and I sees the close.
        intercept: (_direction, message) => {
          sent.push(message.length);
          if (seen++ !== 0) return [message];
          const t = message.slice();
          t[t.length - 1] = (t[t.length - 1] ?? 0) ^ 1;
          return [t];
        },
      }),
    );
    expect(await i.submit(answer)).toBe('ok');
    expect(await stage(r, 'failed')).toEqual({ kind: 'failed', reason: 'unverified' });
    expect(await stage(i, 'failed')).toEqual({ kind: 'failed', reason: 'closed' });
    expect(sent).toEqual([48]);
  });

  it('no longer expires once Noise_KK completed (§12)', async () => {
    vi.useFakeTimers();
    const { i, r, answer } = await exchanged();
    expect(await i.submit(answer)).toBe('ok');
    await vi.waitFor(() => {
      expect(i.stage.kind).toBe('connected');
      expect(r.stage.kind).toBe('connected');
    });
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(i.stage.kind).toBe('connected');
    expect(r.stage.kind).toBe('connected');
    i.end();
  });

  it('uses the STUN servers otherwise (D209)', async () => {
    const f = flows(network(), false);
    f.i.begin();
    await stage(f.i, 'offer');
    expect(f.net.options[0]?.iceServers).not.toEqual([]);
    f.i.end();
  });

  it('shows texts that carry only the version and one Noise_K message (§4.1)', async () => {
    const { offer, answer } = await exchanged();
    for (const text of [offer, answer]) {
      const bytes = decodeReconnectionText(text);
      expect(bytes[0]).toBe(1);
      expect(bytes.length).toBeGreaterThan(133);
    }
  });

  it("refuses R's texts that do not open and keeps waiting for I's (§4.3, §4.4, D215)", async () => {
    const f = flows();
    f.r.begin();
    f.other.begin();
    const fromOther = textOf(await stage(f.other, 'offer'));
    expect(await f.r.submit('not ~ base45')).toBe('malformed');
    expect(await f.r.submit('')).toBe('malformed');
    // C sealed its offer to R, but R picked I.
    expect(await f.r.submit(fromOther)).toBe('not-from-peer');
    const bytes = decodeReconnectionText(fromOther);
    expect(await f.r.submit(encodeReconnectionText(bytes.slice(0, 60)))).toBe('malformed');
    bytes[0] = 2;
    expect(await f.r.submit(encodeReconnectionText(bytes))).toBe('version');
    expect(f.r.stage.kind).toBe('scan');

    f.i.begin();
    const offer = textOf(await stage(f.i, 'offer'));
    expect(await f.r.submit(offer)).toBe('ok');
    await stage(f.r, 'answer');
    f.other.end();
  });

  it("refuses I's own text, and R's answer of another session, and keeps waiting (§4.3)", async () => {
    const { i, offer, answer, make, grant } = await exchanged();
    expect(await i.submit(offer)).toBe('not-from-peer');
    // R answers an older offer of I: its sessionId is not this session's.
    const old = make('initiator', grant('i', 'r'));
    const r2 = make('responder', grant('r', 'i'));
    old.begin();
    r2.begin();
    expect(await r2.submit(textOf(await stage(old, 'offer')))).toBe('ok');
    const stale = textOf(await stage(r2, 'answer'));
    expect(await i.submit(stale)).toBe('malformed');
    expect(i.stage.kind).toBe('offer');
    expect(await i.submit(answer)).toBe('ok');
    await stage(i, 'connected');
    for (const f of [old, r2]) f.end();
  });

  it('takes nothing once ended, and closes the connection (D93)', async () => {
    const { i, r, answer, net } = await exchanged();
    i.end();
    r.end();
    expect(await i.submit(answer)).toBe('unavailable');
    expect(net.closed.sort()).toEqual(['i', 'r']);
    expect(i.stage.kind).toBe('offer');
  });

  it('answers a pending paste once the flow ends', async () => {
    const f = flows();
    f.r.begin();
    f.other.begin();
    const fromOther = textOf(await stage(f.other, 'offer'));
    // The flow has not read it yet when it ends.
    const pending = f.r.submit(fromOther);
    f.r.end();
    expect(await pending).toBe('unavailable');
    f.other.end();
  });

  it('expires 10 minutes after its payload, before Noise_KK (§12)', async () => {
    vi.useFakeTimers();
    const f = flows();
    f.i.begin();
    // Runs what is pending without moving the clock, as waitFor would.
    await vi.advanceTimersByTimeAsync(0);
    expect(f.i.stage.kind).toBe('offer');
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 - 1);
    expect(f.i.stage.kind).toBe('offer');
    await vi.advanceTimersByTimeAsync(1);
    expect(f.i.stage).toEqual({ kind: 'failed', reason: 'expired' });
    expect(f.net.closed).toEqual(['i']);
  });

  it('fails when the peer closes the connection', async () => {
    const { i, r, answer } = await exchanged();
    expect(await i.submit(answer)).toBe('ok');
    await stage(r, 'connected');
    r.end();
    expect(await stage(i, 'failed')).toEqual({ kind: 'failed', reason: 'closed' });
  });

  it('fails when the connection cannot be set up, or the payload cannot carry it', async () => {
    const { grant } = devices();
    const failing = (offerLink: SyncPort['offerLink']) =>
      new Syncing({
        port: { offerLink, answerLink: () => Promise.reject(new Error('unused')) },
        sameNetwork: true,
        stun: { kind: 'default' },
        grant: grant('i', 'r'),
        role: 'initiator',
        onChange: () => undefined,
      });
    const closed = failing(() => Promise.reject(new TransportClosedError('error')));
    closed.begin();
    expect(await stage(closed, 'failed')).toEqual({ kind: 'failed', reason: 'closed' });

    let shut = false;
    const empty: LinkFields = {
      role: 'initiator',
      setup: 'actpass',
      fingerprint: new Uint8Array(32),
      ufrag: 'abcd',
      pwd: 'a'.repeat(22),
      candidates: [],
      sessionId: new Uint8Array(16),
    };
    const uncarried = failing(() =>
      Promise.resolve({
        link: empty,
        accept: () => Promise.reject(new Error('unused')),
        close: () => {
          shut = true;
        },
      }),
    );
    uncarried.begin();
    expect(await stage(uncarried, 'failed')).toEqual({ kind: 'failed', reason: 'error' });
    expect(shut).toBe(true);
  });

  it('closes a link gathered after the flow ended', async () => {
    const net = network();
    const f = flows(net);
    f.i.begin();
    f.i.end();
    await vi.waitFor(() => {
      expect(net.closed).toEqual(['i']);
    });
    expect(f.i.stage.kind).toBe('preparing');
  });
});
