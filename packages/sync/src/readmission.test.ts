import {
  Keyring,
  type SymmetricKey,
  checkReadmissionMac,
  generateKey,
  initCrypto,
  readmissionMac,
} from '@blindvault/crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import { FrameReader } from './frames';
import { type MemoryPairOptions, memoryPair } from './memory';
import { type Message, decodeMessage } from './messages';
import type { Role } from './payload';
import { type DevicesHeld, type ReadmitOptions, readmissionWrites, readmit } from './readmission';
import { PairingError, PairingSession } from './session';
import { TransferRefusal } from './transfer';

beforeAll(initCrypto);

const H = new Uint8Array(64).fill(0x50);
const recordsI = [Uint8Array.of(1), new Uint8Array(100_000).fill(2)];
const recordsR = [Uint8Array.of(3), Uint8Array.of(4), Uint8Array.of(5)];
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PairingError) return error.reason;
    throw error;
  }
  throw new Error('expected the session to end');
}

/** Decodes the plaintext messages crossing the link, for the order checks. */
function recorder() {
  const log: { direction: string; t: string }[] = [];
  const readers = { 'a-to-b': new FrameReader(), 'b-to-a': new FrameReader() };
  const intercept: MemoryPairOptions['intercept'] = (direction, frame) => {
    const bytes = readers[direction].push(frame.slice());
    if (bytes) log.push({ direction, t: decodeMessage(bytes).t });
    return [frame];
  };
  return { log, intercept };
}

interface Side {
  readonly role: Role;
  readonly key: SymmetricKey;
  readonly held: DevicesHeld;
  readonly name: string;
  readonly records: readonly Uint8Array[];
}

/** The callbacks of one side, recording what the protocol hands them. */
function options(side: Side, overrides: Partial<ReadmitOptions<string>> = {}) {
  const peerRole: Role = side.role === 'initiator' ? 'responder' : 'initiator';
  const seen = {
    admitted: [] as { writes: { own: boolean; peer: boolean }; peerName: string }[],
    merged: [] as Uint8Array[][],
  };
  const opts: ReadmitOptions<string> = {
    role: side.role,
    mac: () => readmissionMac(side.key, side.role, H),
    checkPeerMac: (mac) => checkReadmissionMac(side.key, peerRole, H, mac),
    devices: { ...side.held, name: side.name },
    admit: (writes, peer) => {
      seen.admitted.push({ writes, peerName: peer.name });
      return Promise.resolve();
    },
    records: () => Promise.resolve(side.records),
    merge: (records) => {
      seen.merged.push([...records]);
      return Promise.resolve(`merged ${String(records.length)}`);
    },
    ...overrides,
  };
  return { opts, seen };
}

/** I on side a, R on side b, both past their confirmations, with the same Master Key unless told. */
function pair(
  link: MemoryPairOptions = {},
  sides: { sameKey?: boolean; heldI?: DevicesHeld; heldR?: DevicesHeld } = {},
) {
  const pairLink = memoryPair(link);
  const a = new PairingSession(pairLink.a);
  const b = new PairingSession(pairLink.b);
  const keyring = new Keyring();
  const key = generateKey(keyring);
  const other = sides.sameKey === false ? generateKey(keyring) : key;
  const i: Side = {
    role: 'initiator',
    key,
    held: sides.heldI ?? { own: false, peer: true },
    name: 'Restored laptop',
    records: recordsI,
  };
  const r: Side = {
    role: 'responder',
    key: other,
    held: sides.heldR ?? { own: true, peer: false },
    name: 'Phone',
    records: recordsR,
  };
  return { a, b, i, r };
}

describe('re-admission (pairing-protocol.md §9, sync-protocol.md §2.3)', () => {
  it('confirms the keys, exchanges devices, writes, transfers both ways and merges on each side', async () => {
    const { log, intercept } = recorder();
    const { a, b, i, r } = pair({ intercept });
    const sideI = options(i);
    const sideR = options(r);
    const [outI, outR] = await Promise.all([readmit(a, sideI.opts), readmit(b, sideR.opts)]);
    expect(outI).toEqual({ result: 'merged 3', peerCommitted: true });
    expect(outR).toEqual({ result: 'merged 2', peerCommitted: true });
    // I is the unregistered one, R holds its own record: R writes I's record (§9 step 4).
    expect(sideI.seen.admitted).toEqual([
      { writes: { own: false, peer: false }, peerName: 'Phone' },
    ]);
    expect(sideR.seen.admitted).toEqual([
      { writes: { own: false, peer: true }, peerName: 'Restored laptop' },
    ]);
    expect(sideI.seen.merged.map((m) => m.map(toHex))).toEqual([recordsR.map(toHex)]);
    expect(sideR.seen.merged.map((m) => m.map(toHex))).toEqual([recordsI.map(toHex)]);
    // The MACs and devices come first on both sides; committed is each side's last message.
    for (const direction of ['a-to-b', 'b-to-a']) {
      const sent = log.filter((m) => m.direction === direction).map((m) => m.t);
      const records = direction === 'a-to-b' ? recordsI.length : recordsR.length;
      expect(sent).toEqual([
        'key-confirmation',
        'devices',
        'records-begin',
        ...Array<string>(records).fill('record'),
        'records-end',
        'committed',
      ]);
    }
    expect(a.error?.reason).toBe('closed');
    expect(b.error?.reason).toBe('closed');
  });

  it('aborts with different-vaults when the Master Keys differ, before any devices or write (CRYPTO-INV-014)', async () => {
    const { log, intercept } = recorder();
    const { a, b, i, r } = pair({ intercept }, { sameKey: false });
    const sideI = options(i);
    const sideR = options(r);
    const [outI, outR] = await Promise.allSettled([readmit(a, sideI.opts), readmit(b, sideR.opts)]);
    for (const out of [outI, outR]) {
      expect(out.status).toBe('rejected');
      if (out.status === 'rejected')
        expect((out.reason as PairingError).reason).toBe('different-vaults');
    }
    expect(sideI.seen.admitted).toEqual([]);
    expect(sideR.seen.admitted).toEqual([]);
    expect(log.map((m) => m.t).filter((t) => t !== 'abort')).toEqual([
      'key-confirmation',
      'key-confirmation',
    ]);
  });

  it("refuses a peer that echoes this device's own MAC back: the role is bound (D29)", async () => {
    const { a, b, i } = pair();
    const sideI = options(i);
    const running = readmit(a, sideI.opts);
    const first = await b.receive();
    if (first.t !== 'key-confirmation') throw new Error(first.t);
    await b.send({ t: 'key-confirmation', mac: first.mac });
    expect(await failure(running)).toBe('different-vaults');
    expect(sideI.seen.admitted).toEqual([]);
  });

  it.each<[string, Message[]]>([
    ['devices before key-confirmation', [{ t: 'devices', own: true, peer: false, name: 'X' }]],
    ['a record before devices', [{ t: 'key-confirmation', mac: new Uint8Array(32) }]],
  ])(
    'aborts on %s (protocol-error or different-vaults), writing nothing',
    async (_case, messages) => {
      const { a, b, i } = pair();
      const sideI = options(i);
      const running = readmit(a, sideI.opts);
      for (const m of messages) await b.send(m);
      expect(['protocol-error', 'different-vaults']).toContain(await failure(running));
      expect(sideI.seen.admitted).toEqual([]);
    },
  );

  it.each<[string, Message[]]>([
    ['a record before records-begin', [{ t: 'record', r: Uint8Array.of(1) }]],
    [
      'fewer records than count',
      [
        { t: 'records-begin', count: 2 },
        { t: 'record', r: Uint8Array.of(1) },
        { t: 'records-end' },
      ],
    ],
    [
      'more records than count',
      [
        { t: 'records-begin', count: 1 },
        { t: 'record', r: Uint8Array.of(1) },
        { t: 'record', r: Uint8Array.of(2) },
      ],
    ],
    ['committed before the transfer', [{ t: 'committed' }]],
  ])('aborts on %s in the transfer (protocol-error), merging nothing', async (_case, messages) => {
    const { a, b, i, r } = pair();
    const sideI = options(i);
    const running = readmit(a, sideI.opts);
    // A peer that follows §9 up to the transfer, then breaks it.
    const mac = await b.receive();
    if (mac.t !== 'key-confirmation') throw new Error(mac.t);
    await b.send({ t: 'key-confirmation', mac: readmissionMac(r.key, 'responder', H) });
    await b.receive();
    await b.send({ t: 'devices', ...r.held, name: r.name });
    for (const m of messages) await b.send(m).catch(() => undefined);
    expect(await failure(running)).toBe('protocol-error');
    expect(sideI.seen.merged).toEqual([]);
  });

  it('a malformed devices message aborts (protocol-error) before any write', async () => {
    const { a, b, i, r } = pair();
    const sideI = options(i);
    const running = readmit(a, sideI.opts);
    await b.receive();
    await b.send({ t: 'key-confirmation', mac: readmissionMac(r.key, 'responder', H) });
    await b.receive();
    await b.send({ t: 'records-begin', count: 0 });
    expect(await failure(running)).toBe('protocol-error');
    expect(sideI.seen.admitted).toEqual([]);
  });

  it('ends both sides with the reason a write was refused for (retired-peer)', async () => {
    const { a, b, i, r } = pair();
    const sideI = options(i, {
      admit: () => Promise.reject(new TransferRefusal('retired-peer')),
    });
    const sideR = options(r);
    const [outI, outR] = await Promise.allSettled([readmit(a, sideI.opts), readmit(b, sideR.opts)]);
    expect(outI.status === 'rejected' && (outI.reason as PairingError).reason).toBe('retired-peer');
    expect(outR.status === 'rejected' && (outR.reason as PairingError).reason).toBe('retired-peer');
    expect(sideR.seen.merged).toEqual([]);
  });

  it('aborts with unsupported-format before the merge of the side that refused, and the peer ends (D206)', async () => {
    const { a, b, i, r } = pair();
    const sideI = options(i, {
      merge: () => Promise.reject(new TransferRefusal('unsupported-format')),
    });
    const sideR = options(r);
    const [outI, outR] = await Promise.allSettled([readmit(a, sideI.opts), readmit(b, sideR.opts)]);
    expect(outI.status === 'rejected' && (outI.reason as PairingError).reason).toBe(
      'unsupported-format',
    );
    // R may have merged I's records before the abort reached it: a merge of valid records stays,
    // and R learns that I did not commit.
    if (outR.status === 'fulfilled') expect(outR.value.peerCommitted).toBe(false);
    else expect((outR.reason as PairingError).reason).toBe('unsupported-format');
  });

  it("keeps this side's merge when the peer's committed never comes, and says so", async () => {
    const { a, b, i, r } = pair();
    const sideI = options(i);
    const running = readmit(a, sideI.opts);
    await b.receive();
    await b.send({ t: 'key-confirmation', mac: readmissionMac(r.key, 'responder', H) });
    await b.receive();
    await b.send({ t: 'devices', ...r.held, name: r.name });
    await b.send({ t: 'records-begin', count: 0 });
    await b.send({ t: 'records-end' });
    // I's transfer, then its committed: the peer drops the link instead of committing.
    for (;;) if ((await b.receive()).t === 'committed') break;
    await b.abort('locked');
    expect(await running).toEqual({ result: 'merged 0', peerCommitted: false });
  });

  it('merges nothing once the session ended before the merge, with its reason (D93)', async () => {
    const { a, b, i, r } = pair();
    const sideI = options(i, {
      records: async () => {
        await a.abort('locked');
        return recordsI;
      },
    });
    const sideR = options(r);
    const [outI, outR] = await Promise.allSettled([readmit(a, sideI.opts), readmit(b, sideR.opts)]);
    expect(outI.status === 'rejected' && (outI.reason as PairingError).reason).toBe('locked');
    // R sees the abort, or the link that closed after it, whichever its read meets first.
    expect(outR.status).toBe('rejected');
    if (outR.status === 'rejected') {
      expect(['locked', 'closed']).toContain((outR.reason as PairingError).reason);
    }
    expect(sideI.seen.merged).toEqual([]);
    expect(sideR.seen.merged).toEqual([]);
  });
});

describe('who writes which Device record (pairing-protocol.md §9 step 4, D35, D49)', () => {
  const held = (own: boolean, peer: boolean): DevicesHeld => ({ own, peer });

  it.each<
    [
      string,
      DevicesHeld,
      DevicesHeld,
      { own: boolean; peer: boolean },
      { own: boolean; peer: boolean },
    ]
  >([
    // I unregistered, R registered and unknown to I: R writes I's record; I's merge brings R's.
    [
      'I unregistered, R registered',
      held(false, false),
      held(true, false),
      { own: false, peer: false },
      { own: false, peer: true },
    ],
    // The reverse: I writes R's record.
    [
      'R unregistered, I registered',
      held(true, false),
      held(false, false),
      { own: false, peer: true },
      { own: false, peer: false },
    ],
    // Neither holds its own record: I writes both.
    [
      'neither registered',
      held(false, false),
      held(false, false),
      { own: true, peer: true },
      { own: false, peer: false },
    ],
    // Both hold both: nothing is written, the re-admission is a merge (D206).
    [
      'both hold both',
      held(true, true),
      held(true, true),
      { own: false, peer: false },
      { own: false, peer: false },
    ],
    // Both registered, each unknown to the other: each record is held by its owner, so none is written.
    [
      'both registered, unknown to each other',
      held(true, false),
      held(true, false),
      { own: false, peer: false },
      { own: false, peer: false },
    ],
    // I unregistered, but R already holds I's record: nothing missing on both sides for I.
    [
      'R holds the record of an unregistered I',
      held(false, true),
      held(true, true),
      { own: false, peer: false },
      { own: false, peer: false },
    ],
  ])('%s', (_case, i, r, writesI, writesR) => {
    expect(readmissionWrites('initiator', i, r)).toEqual(writesI);
    expect(readmissionWrites('responder', r, i)).toEqual(writesR);
  });
});
