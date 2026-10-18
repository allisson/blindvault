// The manual sync flow (sync-protocol.md §3 to §5, §11, §12, D215 to D218): two flows, each with its
// own identity, over an in-memory link in place of WebRTC. The payload, the delivery, `Noise_KK` and
// the session messages are tested in `packages/sync`; here, what the screens drive: the texts, the
// refusals that keep the wait going, the handshake (D217), the connection and its end, by `abort`
// once the session is open (D218), and a retired peer told so and nothing else, right after the
// handshake (D219) or once it becomes retired during the session (D220); the summaries, the transfer
// and the commit that follow (D222).

import { Keyring, generateDeviceIdentity, initCrypto } from '@blindvault/crypto';
import {
  type ConnectionOptions,
  type LinkFields,
  type MemoryPair,
  type MemoryPairOptions,
  SyncError,
  SyncSession,
  TransportClosedError,
  decodeReconnectionText,
  encodeReconnectionText,
  memoryPair,
  openReconnection,
  sealReconnection,
  syncHandshake,
} from '@blindvault/sync';
import {
  type MergeResult,
  type SyncGrant,
  SyncRejectedError,
  type SyncResult,
} from '@blindvault/vault';
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

/** What a merge of nothing reports. */
const SYNCED: SyncResult = {
  added: 0,
  replaced: 0,
  versions: 0,
  phraseChanged: false,
  newDevices: [],
  retiredDevices: [],
  droppedLosers: [],
  rejected: [],
  ownRetired: false,
};

/** A vault holding nothing, so the exchange sends and merges nothing. */
const EMPTY = {
  summary: () => [],
  records: () => Promise.resolve([]),
  merge: () => Promise.resolve(SYNCED),
};

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
    peerRetirement: () => Promise.resolve(undefined),
    mergeOwnRetirement: () => Promise.reject(new Error('unexpected retired')),
    ...EMPTY,
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
    await stage(i, 'synced');
    await stage(r, 'synced');
    expect(net.options.map((o) => o.iceServers)).toEqual([[], []]);
    // The two Noise_KK messages come first (CRYPTO-INV-008, D217); the rest is sealed in the channel.
    expect(sent.slice(0, 2)).toEqual([
      ['a-to-b', 48],
      ['b-to-a', 48],
    ]);
    expect(sent.slice(2).every(([, length]) => length > 16)).toBe(true);
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
      expect(i.stage.kind).toBe('synced');
      expect(r.stage.kind).toBe('synced');
    });
    // The live session has no timeout either (§12).
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(i.stage.kind).toBe('synced');
    expect(r.stage.kind).toBe('synced');
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
    await stage(i, 'synced');
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

  it('fails as closed when the link closes with no abort', async () => {
    const { i, r, answer, net } = await exchanged();
    expect(await i.submit(answer)).toBe('ok');
    await stage(r, 'synced');
    net.pair()?.b.close();
    expect(await stage(i, 'failed')).toEqual({ kind: 'failed', reason: 'closed' });
  });

  it.each(['ended', 'locked'] as const)(
    'sends abort with %s once connected, and the peer shows it (§11.2, D93, D218)',
    async (reason) => {
      vi.useFakeTimers();
      const sent: [string, number][] = [];
      const { i, r, answer, net } = await exchanged(
        network({
          intercept: (direction, message) => {
            sent.push([direction, message.length]);
            return [message];
          },
        }),
      );
      expect(await i.submit(answer)).toBe('ok');
      await vi.waitFor(() => {
        expect(i.stage.kind).toBe('synced');
        expect(r.stage.kind).toBe('synced');
      });
      const before = sent.length;
      r.end(reason);
      await vi.waitFor(() => {
        expect(i.stage).toEqual({ kind: 'failed', reason });
      });
      // R's local end shows no failure: the screen is closed.
      expect(r.stage.kind).toBe('synced');
      // One channel message: the abort, sealed.
      expect(sent.slice(before).map(([direction]) => direction)).toEqual(['b-to-a']);
      expect(sent[before]?.[1]).toBeGreaterThan(16);
      // R closes its connection only once the abort had time to leave.
      expect(net.closed).not.toContain('r');
      await vi.advanceTimersByTimeAsync(3_000);
      expect(net.closed).toContain('r');
    },
  );

  it('ends before Noise_KK with no abort, and closes at once', async () => {
    const sent: number[] = [];
    const { r, net } = await exchanged(
      network({
        intercept: (_direction, message) => {
          sent.push(message.length);
          return [message];
        },
      }),
    );
    r.end('locked');
    expect(net.closed).toEqual(['r']);
    expect(sent).toEqual([]);
  });

  it.each([
    ['a message out of the order of the summaries (§7, §11.1)', 'summary'],
    ['an abort retired-peer with no retired before it (§6, D219)', 'abort'],
    ['a second committed (§11.1, D222)', 'committed'],
  ] as const)('fails with protocol-error on %s', async (_case, kind) => {
    // R is played here, so it can send what the flow never sends: a message after Noise_KK.
    const net = network();
    const { identities } = devices();
    const i = new Syncing({
      port: net.port,
      sameNetwork: true,
      stun: { kind: 'default' },
      grant: {
        identity: identities.i,
        vaultId: VAULT,
        peerPublicKey: identities.r.publicKey,
        peerDeviceId: identities.r.deviceId,
        peerName: 'r',
        peerRetirement: () => Promise.resolve(undefined),
        mergeOwnRetirement: () => Promise.reject(new Error('unexpected retired')),
        ...EMPTY,
      },
      role: 'initiator',
      onChange: () => undefined,
    });
    i.begin();
    const offerText = textOf(await stage(i, 'offer'));
    const keys = { identity: identities.r, peerPublicKey: identities.i.publicKey, vaultId: VAULT };
    const offer = openReconnection(decodeReconnectionText(offerText), keys, { role: 'initiator' });
    const link: LinkFields = {
      ...offer.reconnection,
      role: 'responder',
      setup: 'active',
      fingerprint: new Uint8Array(32).fill(0x30),
    };
    const sealed = sealReconnection(link, keys);
    expect(await i.submit(encodeReconnectionText(sealed.bytes))).toBe('ok');
    const pair = net.pair();
    if (!pair) throw new Error('no link');
    const { channel } = await syncHandshake(pair.b, {
      role: 'responder',
      identity: identities.r,
      peerPublicKey: identities.i.publicKey,
      initiator: { message: offer.message, fingerprint: offer.reconnection.fingerprint },
      responder: { message: sealed.message, fingerprint: link.fingerprint },
    });
    await stage(i, 'connected');
    const session = new SyncSession(channel);
    if (kind === 'abort') {
      await session.abort('retired-peer');
      expect(await stage(i, 'failed')).toEqual({ kind: 'failed', reason: 'protocol-error' });
      return;
    }
    if (kind === 'committed') {
      await session.send({ t: 'summary-begin', count: 0 });
      await session.send({ t: 'summary-end' });
      await session.send({ t: 'records-begin', count: 0 });
      await session.send({ t: 'records-end' });
      await session.send({ t: 'committed' });
      await stage(i, 'synced');
      await session.send({ t: 'committed' });
    } else {
      await session.send({ t: 'summary-end' });
    }
    expect(await stage(i, 'failed')).toEqual({ kind: 'failed', reason: 'protocol-error' });
    let ended: unknown;
    while (!ended) {
      ended = await session.receive().then(
        () => undefined,
        (error: unknown) => error,
      );
    }
    expect(ended).toBeInstanceOf(SyncError);
    expect(ended).toMatchObject({ reason: 'protocol-error', by: 'remote' });
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

describe('retired peer (sync-protocol.md §6, D31, D45, D219)', () => {
  const RETIRED = new Uint8Array(40).fill(7);
  const MERGED = {} as MergeResult;

  /** I and R connected through their texts, with grants changed as given, every frame seen. */
  async function retiring(
    iGrant: (g: SyncGrant) => Partial<SyncGrant>,
    rGrant: (g: SyncGrant) => Partial<SyncGrant>,
  ) {
    const sent: string[] = [];
    const net = network({
      intercept: (direction, message) => {
        sent.push(direction);
        return [message];
      },
    });
    const { grant } = devices();
    // Every stage each flow went through.
    const seen = { i: [] as string[], r: [] as string[] };
    const make = (role: 'initiator' | 'responder', g: SyncGrant) => {
      const flow: Syncing = new Syncing({
        port: net.port,
        sameNetwork: true,
        stun: { kind: 'default' },
        grant: g,
        role,
        onChange: () => {
          seen[role === 'initiator' ? 'i' : 'r'].push(flow.stage.kind);
        },
      });
      return flow;
    };
    const gi = grant('i', 'r');
    const gr = grant('r', 'i');
    const i = make('initiator', { ...gi, ...iGrant(gi) });
    const r = make('responder', { ...gr, ...rGrant(gr) });
    i.begin();
    r.begin();
    expect(await r.submit(textOf(await stage(i, 'offer')))).toBe('ok');
    expect(await i.submit(textOf(await stage(r, 'answer')))).toBe('ok');
    return { i, r, sent, seen };
  }

  /** I's vault: the peer's record turns retired once `retire` is called; each read counted. */
  function retirable() {
    let held: Uint8Array | undefined;
    let failing = false;
    const reads = { count: 0 };
    return {
      reads,
      retire: () => {
        held = RETIRED;
      },
      fail: () => {
        failing = true;
      },
      peerRetirement: () => {
        reads.count++;
        return failing
          ? Promise.reject(new SyncRejectedError('verification-failed'))
          : Promise.resolve(held?.slice());
      },
    };
  }

  const merging = (merged: Uint8Array[]) => () => ({
    mergeOwnRetirement: (envelope: Uint8Array) => {
      merged.push(envelope);
      return Promise.resolve(MERGED);
    },
  });

  it('sends the peer only its retired record and abort, and the peer merges it (CRYPTO-INV-015)', async () => {
    const merged: Uint8Array[] = [];
    const { i, r, sent } = await retiring(
      () => ({ peerRetirement: () => Promise.resolve(RETIRED.slice()) }),
      () => ({
        mergeOwnRetirement: (envelope) => {
          merged.push(envelope);
          return Promise.resolve(MERGED);
        },
      }),
    );
    expect(await stage(i, 'failed')).toEqual({ kind: 'failed', reason: 'retired-peer' });
    expect(await stage(r, 'failed')).toEqual({ kind: 'failed', reason: 'retired' });
    expect(merged).toEqual([RETIRED]);
    // The two handshake messages, then I's `retired` and `abort`: nothing else from I. R, which
    // does not hold I retired, began its summary meanwhile.
    expect(sent.slice(0, 2)).toEqual(['a-to-b', 'b-to-a']);
    expect(sent.slice(2).filter((d) => d === 'a-to-b')).toHaveLength(2);
  });

  it('aborts with protocol-error, merging nothing, on a retired the vault refuses', async () => {
    const { i, r } = await retiring(
      () => ({ peerRetirement: () => Promise.resolve(RETIRED.slice()) }),
      () => ({
        mergeOwnRetirement: () => Promise.reject(new SyncRejectedError('protocol-error')),
      }),
    );
    expect(await stage(i, 'failed')).toEqual({ kind: 'failed', reason: 'retired-peer' });
    expect(await stage(r, 'failed')).toEqual({ kind: 'failed', reason: 'protocol-error' });
  });

  it('sends nothing but abort when the retired record held fails verification', async () => {
    const { i, r, sent } = await retiring(
      () => ({
        peerRetirement: () => Promise.reject(new SyncRejectedError('verification-failed')),
      }),
      () => ({}),
    );
    expect(await stage(i, 'failed')).toEqual({ kind: 'failed', reason: 'verification-failed' });
    expect(await stage(r, 'failed')).toEqual({
      kind: 'failed',
      reason: 'peer-verification-failed',
    });
    expect(sent.slice(2).filter((d) => d === 'a-to-b')).toHaveLength(1);
  });

  it('ends both as retired-peer when each holds the other retired, merging nothing', async () => {
    const merged: Uint8Array[] = [];
    const merge = (envelope: Uint8Array) => {
      merged.push(envelope);
      return Promise.resolve(MERGED);
    };
    const { i, r } = await retiring(
      () => ({ peerRetirement: () => Promise.resolve(RETIRED.slice()), mergeOwnRetirement: merge }),
      () => ({ peerRetirement: () => Promise.resolve(RETIRED.slice()), mergeOwnRetirement: merge }),
    );
    expect(await stage(i, 'failed')).toEqual({ kind: 'failed', reason: 'retired-peer' });
    expect(await stage(r, 'failed')).toEqual({ kind: 'failed', reason: 'retired-peer' });
    expect(merged).toEqual([]);
  });

  it('shows connected only once it knows the peer is not retired', async () => {
    let release!: (value: undefined) => void;
    let reads = 0;
    const { i, r } = await retiring(
      () => ({
        // The check after Noise_KK waits; the one after the merge does not.
        peerRetirement: () =>
          reads++ === 0
            ? new Promise<undefined>((resolve) => {
                release = resolve;
              })
            : Promise.resolve(undefined),
      }),
      () => ({}),
    );
    await stage(r, 'connected');
    await vi.waitFor(() => {
      expect(release).toBeTypeOf('function');
    });
    expect(i.stage.kind).toBe('connecting');
    // R waits for I's summary meanwhile.
    expect(r.stage.kind).toBe('connected');
    release(undefined);
    await stage(i, 'synced');
    i.end();
  });

  describe('during the session (D69, D220)', () => {
    it('sends the peer only its retired record and abort once it turns retired, and the peer merges it', async () => {
      const vault = retirable();
      const merged: Uint8Array[] = [];
      const { i, r, sent } = await retiring(
        () => ({ peerRetirement: vault.peerRetirement }),
        merging(merged),
      );
      await stage(i, 'synced');
      await stage(r, 'synced');
      // After the merge, before committed, the check ran a second time (D220).
      expect(vault.reads.count).toBe(2);
      // Nothing changed: the check reads the record again and the session stays open.
      i.recheck();
      await vi.waitFor(() => {
        expect(vault.reads.count).toBe(3);
      });
      expect(i.stage.kind).toBe('synced');
      const before = sent.length;
      vault.retire();
      i.recheck();
      expect(await stage(i, 'failed')).toEqual({ kind: 'failed', reason: 'retired-peer' });
      expect(await stage(r, 'failed')).toEqual({ kind: 'failed', reason: 'retired' });
      expect(merged).toEqual([RETIRED]);
      expect(sent.slice(before)).toEqual(['a-to-b', 'a-to-b']);
    });

    it('sends one retired and one abort, and never shows connected, when it turns retired during the check after Noise_KK', async () => {
      const vault = retirable();
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const merged: Uint8Array[] = [];
      const { i, r, sent, seen } = await retiring(
        () => ({
          peerRetirement: async () => {
            // The first read waits, and finds the record not retired yet.
            if (vault.reads.count === 0) {
              vault.reads.count++;
              await blocked;
              return undefined;
            }
            return vault.peerRetirement();
          },
        }),
        merging(merged),
      );
      await vi.waitFor(() => {
        expect(vault.reads.count).toBe(1);
      });
      vault.retire();
      i.recheck();
      i.recheck();
      release();
      expect(await stage(i, 'failed')).toEqual({ kind: 'failed', reason: 'retired-peer' });
      expect(await stage(r, 'failed')).toEqual({ kind: 'failed', reason: 'retired' });
      expect(seen.i).not.toContain('connected');
      expect(merged).toEqual([RETIRED]);
      expect(sent.slice(2).filter((d) => d === 'a-to-b')).toHaveLength(2);
    });

    it('sends nothing but abort when the record turns out to fail verification', async () => {
      const vault = retirable();
      const { i, r, sent } = await retiring(
        () => ({ peerRetirement: vault.peerRetirement }),
        () => ({}),
      );
      await stage(i, 'synced');
      await stage(r, 'synced');
      const before = sent.length;
      vault.fail();
      i.recheck();
      expect(await stage(i, 'failed')).toEqual({ kind: 'failed', reason: 'verification-failed' });
      expect(await stage(r, 'failed')).toEqual({
        kind: 'failed',
        reason: 'peer-verification-failed',
      });
      expect(sent.slice(before)).toEqual(['a-to-b']);
    });

    it('reads nothing before Noise_KK, which checks it anyway, nor once the flow ended', async () => {
      const vault = retirable();
      const early = new Syncing({
        port: network().port,
        sameNetwork: true,
        stun: { kind: 'default' },
        grant: { ...devices().grant('i', 'r'), peerRetirement: vault.peerRetirement },
        role: 'initiator',
        onChange: () => undefined,
      });
      early.begin();
      await stage(early, 'offer');
      early.recheck();
      expect(vault.reads.count).toBe(0);
      early.end();

      const after = retirable();
      const { i: ended, r } = await retiring(
        () => ({ peerRetirement: after.peerRetirement }),
        () => ({}),
      );
      await stage(ended, 'synced');
      ended.end();
      after.retire();
      ended.recheck();
      expect(await stage(r, 'failed')).toEqual({ kind: 'failed', reason: 'ended' });
      expect(after.reads.count).toBe(2);
    });
  });
});

describe('summaries and transfer (sync-protocol.md §7 to §9, D69, D222)', () => {
  const ENTRY = {
    recordFormatVersion: 1,
    recordType: 1,
    recordId: new Uint8Array(16).fill(5),
    hlc: { physicalMs: 1_760_000_000_000, counter: 0, deviceId: new Uint8Array(16).fill(6) },
    deleted: false,
    keyEpoch: 1,
  };
  const ENVELOPE = new Uint8Array(40).fill(0x51);

  /** I and R connected through their texts, with grants changed as given, every frame seen. */
  async function connect(
    iGrant: (g: SyncGrant) => Partial<SyncGrant>,
    rGrant: (g: SyncGrant) => Partial<SyncGrant>,
  ) {
    const sent: string[] = [];
    const net = network({
      intercept: (direction, message) => {
        sent.push(direction);
        return [message];
      },
    });
    const { grant } = devices();
    const make = (role: 'initiator' | 'responder', g: SyncGrant) =>
      new Syncing({
        port: net.port,
        sameNetwork: true,
        stun: { kind: 'default' },
        grant: g,
        role,
        onChange: () => undefined,
      });
    const gi = grant('i', 'r');
    const gr = grant('r', 'i');
    const i = make('initiator', { ...gi, ...iGrant(gi) });
    const r = make('responder', { ...gr, ...rGrant(gr) });
    i.begin();
    r.begin();
    expect(await r.submit(textOf(await stage(i, 'offer')))).toBe('ok');
    expect(await i.submit(textOf(await stage(r, 'answer')))).toBe('ok');
    return { i, r, sent };
  }

  it('sends what the peer lacks, merges what it receives, and shows each merge’s result', async () => {
    const selected: unknown[] = [];
    const merged: Uint8Array[][] = [];
    const result: SyncResult = { ...SYNCED, added: 1 };
    const { i, r } = await connect(
      () => ({
        summary: () => [ENTRY],
        records: (keys) => {
          selected.push(...keys);
          return Promise.resolve([ENVELOPE]);
        },
      }),
      () => ({
        merge: (records) => {
          merged.push([...records]);
          return Promise.resolve(result);
        },
      }),
    );
    expect(await stage(r, 'synced')).toEqual({ kind: 'synced', result });
    expect(await stage(i, 'synced')).toEqual({ kind: 'synced', result: SYNCED });
    expect(selected).toEqual([ENTRY]);
    expect(merged).toEqual([[ENVELOPE]]);
    i.end();
  });

  it('names a record of its own that fails verification, and the peer says so, merging nothing (§8, D181)', async () => {
    const record = { recordType: 1 as const, recordId: new Uint8Array(16).fill(5) };
    const merged: unknown[] = [];
    const { i, r } = await connect(
      () => ({
        summary: () => [ENTRY],
        records: () => Promise.reject(new SyncRejectedError('verification-failed', record)),
      }),
      () => ({
        merge: (records) => {
          merged.push(records);
          return Promise.resolve(SYNCED);
        },
      }),
    );
    expect(await stage(i, 'failed')).toEqual({ kind: 'failed', reason: 'send-failed', record });
    expect(await stage(r, 'failed')).toEqual({
      kind: 'failed',
      reason: 'peer-verification-failed',
    });
    expect(merged).toEqual([]);
  });

  it('ends the session once a merge retired this device’s own record, without committed (D69)', async () => {
    const { i, r } = await connect(
      () => ({}),
      () => ({ merge: () => Promise.resolve({ ...SYNCED, ownRetired: true }) }),
    );
    expect(await stage(r, 'failed')).toEqual({ kind: 'failed', reason: 'retired' });
    // I committed meanwhile: it sees R end the sync.
    expect(await stage(i, 'failed')).toEqual({ kind: 'failed', reason: 'ended' });
  });

  it('tells the peer it is retired, instead of committed, when its merge retired it (D69, D220)', async () => {
    let retired = false;
    let atMerge = 0;
    const merged: Uint8Array[] = [];
    const RETIRED = new Uint8Array(40).fill(7);
    const { i, r, sent } = await connect(
      () => ({
        merge: () => {
          retired = true;
          // Everything I sends before its merge has gone: its summary and its transfer.
          atMerge = sent.filter((d) => d === 'a-to-b').length;
          return Promise.resolve(SYNCED);
        },
        peerRetirement: () => Promise.resolve(retired ? RETIRED.slice() : undefined),
      }),
      () => ({
        mergeOwnRetirement: (envelope) => {
          merged.push(envelope);
          return Promise.resolve({} as MergeResult);
        },
      }),
    );
    expect(await stage(i, 'failed')).toEqual({ kind: 'failed', reason: 'retired-peer' });
    expect(await stage(r, 'failed')).toEqual({ kind: 'failed', reason: 'retired' });
    expect(merged).toEqual([RETIRED]);
    // After its merge, I sends the retired record and abort: no committed (CRYPTO-INV-015).
    expect(sent.filter((d) => d === 'a-to-b').length - atMerge).toBe(2);
  });

  it('sends nothing but its retired record and abort once the peer turns retired during the exchange (CRYPTO-INV-015)', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let retired = false;
    let reading = false;
    const RETIRED = new Uint8Array(40).fill(7);
    const merged: Uint8Array[] = [];
    const { i, r, sent } = await connect(
      () => ({
        summary: () => [ENTRY],
        // I reads its records while the peer is retired here.
        records: async () => {
          reading = true;
          await blocked;
          return [ENVELOPE];
        },
        peerRetirement: () => Promise.resolve(retired ? RETIRED.slice() : undefined),
      }),
      () => ({
        mergeOwnRetirement: (envelope) => {
          merged.push(envelope);
          return Promise.resolve({} as MergeResult);
        },
      }),
    );
    await vi.waitFor(() => {
      expect(reading).toBe(true);
    });
    const before = sent.filter((d) => d === 'a-to-b').length;
    retired = true;
    i.recheck();
    expect(await stage(i, 'failed')).toEqual({ kind: 'failed', reason: 'retired-peer' });
    release();
    expect(await stage(r, 'failed')).toEqual({ kind: 'failed', reason: 'retired' });
    expect(merged).toEqual([RETIRED]);
    // From I after the check: `retired` and `abort`, and none of the records read meanwhile.
    expect(sent.filter((d) => d === 'a-to-b').length - before).toBe(2);
  });
});
