import { blobId, initCrypto } from '@blindvault/crypto';
import { describe, expect, it, vi } from 'vitest';

import { BLOB_CHUNK_LENGTH } from './blob-messages';
import { type BlobOptions, BlobPhase, type BlobStore, admissionBlobs } from './blobs';
import { type LiveOptions, liveSession } from './exchange';
import { FrameReader } from './frames';
import { type MemoryPairOptions, memoryPair } from './memory';
import { type MemoryBlobStore, memoryBlobStore } from './memory-blobs';
import { type Message, decodeMessage } from './messages';
import { PairingError, PairingSession } from './session';
import { decodeSyncMessage } from './sync-messages';
import { SyncError, SyncSession } from './sync-session';

// The tables below hash blobs as the file loads.
await initCrypto();

const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
/** A blob of `length` bytes: the phase only hashes it, so any bytes in range will do. */
const blob = (length: number, fill: number) => new Uint8Array(length).fill(fill);
const small = blob(42, 1);
const other = blob(100, 2);
const large = blob(2 * BLOB_CHUNK_LENGTH + 5, 3);
const absent = blob(60, 4);

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PairingError || error instanceof SyncError) return error.reason;
    throw error;
  }
  throw new Error('expected the session to end');
}

/** Decodes the messages crossing the link, with the sizes of the chunks. */
function recorder(decode: (bytes: Uint8Array) => { readonly t: string } = decodeMessage) {
  const log: { direction: string; t: string; size?: number }[] = [];
  const readers = { 'a-to-b': new FrameReader(), 'b-to-a': new FrameReader() };
  const intercept: MemoryPairOptions['intercept'] = (direction, frame) => {
    const bytes = readers[direction].push(frame.slice());
    if (bytes) {
      const message = decode(bytes);
      log.push(
        'c' in message && message.c instanceof Uint8Array
          ? { direction, t: message.t, size: message.c.length }
          : { direction, t: message.t },
      );
    }
    return [frame];
  };
  const sent = (direction: string) => log.filter((m) => m.direction === direction);
  return { log, intercept, sent };
}

/** Two pairing sessions past the commit: A on side a answers, B on side b asks (§8 step 8). */
function pairing(link: MemoryPairOptions = {}) {
  const pair = memoryPair(link);
  return { a: new PairingSession(pair.a), b: new PairingSession(pair.b) };
}

const answering = (store: BlobStore, extra: Partial<BlobOptions> = {}) => ({
  store,
  answers: true,
  peerEnds: true,
  ...extra,
});
const asking = (store: BlobStore) => ({ store, answers: false, peerEnds: false });

/** B's side of a pairing's blob phase, citing `cited` and holding nothing. */
function joining(session: PairingSession, ...cited: Uint8Array[]) {
  const store = memoryBlobStore();
  store.cite(...cited);
  return { store, run: admissionBlobs(session, new BlobPhase(session, asking(store)), true) };
}

const ids = (store: MemoryBlobStore) => [...store.held.keys()].sort();

describe('blob phase of an admission (sync-protocol.md §10.1, pairing-protocol.md §8, §9)', () => {
  it('B asks for what it lacks, A answers each in order, B writes each blob that matches', async () => {
    const { log, intercept, sent } = recorder();
    const { a, b } = pairing({ intercept });
    const storeA = memoryBlobStore(small, large);
    const joined = joining(b, blobId(small), blobId(absent), blobId(large));
    await Promise.all([admissionBlobs(a, new BlobPhase(a, answering(storeA)), false), joined.run]);
    expect(joined.store.written.map(toHex)).toEqual([blobId(small), blobId(large)].map(toHex));
    expect(toHex(joined.store.held.get(toHex(blobId(large))) ?? new Uint8Array())).toBe(
      toHex(large),
    );
    expect(joined.store.rejectedIds).toEqual([]);
    expect(sent('b-to-a').map((m) => m.t)).toEqual(['blobs-want', 'blobs-end']);
    expect(sent('a-to-b')).toEqual([
      { direction: 'a-to-b', t: 'blob-begin' },
      { direction: 'a-to-b', t: 'blob-chunk', size: 42 },
      { direction: 'a-to-b', t: 'blob-end' },
      { direction: 'a-to-b', t: 'blob-missing' },
      { direction: 'a-to-b', t: 'blob-begin' },
      // Full chunks of 1 MiB, then the rest.
      { direction: 'a-to-b', t: 'blob-chunk', size: BLOB_CHUNK_LENGTH },
      { direction: 'a-to-b', t: 'blob-chunk', size: BLOB_CHUNK_LENGTH },
      { direction: 'a-to-b', t: 'blob-chunk', size: 5 },
      { direction: 'a-to-b', t: 'blob-end' },
    ]);
    expect(log).toHaveLength(11);
  });

  it('ends a re-admission with both sides holding the same blobs', async () => {
    const { a, b } = pairing();
    const storeI = memoryBlobStore(small, large);
    const storeR = memoryBlobStore(other);
    storeI.cite(blobId(other), blobId(absent));
    storeR.cite(blobId(small), blobId(large));
    const both = (store: BlobStore) => ({ store, answers: true, peerEnds: true });
    await Promise.all([
      admissionBlobs(a, new BlobPhase(a, both(storeI)), true),
      admissionBlobs(b, new BlobPhase(b, both(storeR)), true),
    ]);
    expect(ids(storeI)).toEqual(ids(storeR));
    expect(ids(storeI)).toEqual([small, other, large].map((x) => toHex(blobId(x))).sort());
  });

  it('asks in messages of 16,384 IDs at most, each ID once per session', async () => {
    const { intercept, sent } = recorder();
    const { a, b } = pairing({ intercept });
    const store = memoryBlobStore();
    const wanted = Array.from({ length: 16_385 }, (_, i) => {
      const id = new Uint8Array(32);
      new DataView(id.buffer).setUint32(0, i);
      return id;
    });
    store.cite(...wanted, wanted[0] ?? new Uint8Array(32));
    const phase = new BlobPhase(b, asking(store));
    const answeredAll = admissionBlobs(a, new BlobPhase(a, answering(memoryBlobStore())), false);
    await phase.ask();
    await phase.ask();
    await phase.end();
    while (!phase.done) await phase.receive(await b.receive());
    await answeredAll;
    const wants = sent('b-to-a').filter((m) => m.t === 'blobs-want');
    expect(wants).toHaveLength(2);
    expect(sent('a-to-b').filter((m) => m.t === 'blob-missing')).toHaveLength(16_385);
  }, 30_000);

  it('rejects and reports a blob that does not match its blobId, then goes on (D278)', async () => {
    const { a, b } = pairing();
    const joined = joining(b, blobId(small), blobId(other));
    expect((await a.receive()).t).toBe('blobs-want');
    expect((await a.receive()).t).toBe('blobs-end');
    const forged = small.slice();
    forged[0] = 9;
    await a.send({ t: 'blob-begin', id: blobId(small), size: forged.length });
    await a.send({ t: 'blob-chunk', c: forged });
    await a.send({ t: 'blob-end' });
    await a.send({ t: 'blob-begin', id: blobId(other), size: other.length });
    await a.send({ t: 'blob-chunk', c: other });
    await a.send({ t: 'blob-end' });
    await joined.run;
    expect(joined.store.rejectedIds.map(toHex)).toEqual([toHex(blobId(small))]);
    expect(joined.store.written.map(toHex)).toEqual([toHex(blobId(other))]);
    expect(b.error).toBeNull();
  });

  it('deletes a held blob that fails its hash and answers it missing', async () => {
    const { a, b } = pairing();
    const storeA = memoryBlobStore(other);
    storeA.held.set(toHex(blobId(small)), blob(42, 7));
    const joined = joining(b, blobId(small), blobId(other));
    await Promise.all([admissionBlobs(a, new BlobPhase(a, answering(storeA)), false), joined.run]);
    expect(storeA.discarded.map(toHex)).toEqual([toHex(blobId(small))]);
    expect(storeA.held.has(toHex(blobId(small)))).toBe(false);
    expect(joined.store.written.map(toHex)).toEqual([toHex(blobId(other))]);
    expect(joined.store.rejectedIds).toEqual([]);
  });

  it('runs the check of §6 before each unit leaves', async () => {
    const { a, b } = pairing();
    const check = vi.fn(() => Promise.resolve());
    const joined = joining(b, blobId(small), blobId(absent));
    await Promise.all([
      admissionBlobs(a, new BlobPhase(a, answering(memoryBlobStore(small), { check })), false),
      joined.run,
    ]);
    expect(check).toHaveBeenCalledTimes(2);
  });

  const unit = (id: Uint8Array, bytes: Uint8Array): Message[] => [
    { t: 'blob-begin', id, size: bytes.length },
    { t: 'blob-chunk', c: bytes },
    { t: 'blob-end' },
  ];

  it.each<[string, Message[]]>([
    ['an answer for an ID not asked for', [{ t: 'blob-missing', id: blobId(absent) }]],
    ['a unit for an ID not asked for', unit(blobId(absent), absent)],
    ['an answer out of the order asked', [{ t: 'blob-missing', id: blobId(other) }]],
    ['a unit out of the order asked', unit(blobId(other), other)],
    [
      'a chunk that is not full before the last',
      [
        { t: 'blob-begin', id: blobId(small), size: BLOB_CHUNK_LENGTH + 10 },
        { t: 'blob-chunk', c: new Uint8Array(10) },
      ],
    ],
    [
      'chunks that run past the length',
      [
        { t: 'blob-begin', id: blobId(small), size: BLOB_CHUNK_LENGTH + 10 },
        { t: 'blob-chunk', c: new Uint8Array(BLOB_CHUNK_LENGTH) },
        { t: 'blob-chunk', c: new Uint8Array(BLOB_CHUNK_LENGTH) },
      ],
    ],
    [
      'a blob-end before the length is reached',
      [
        { t: 'blob-begin', id: blobId(small), size: BLOB_CHUNK_LENGTH + 10 },
        { t: 'blob-chunk', c: new Uint8Array(BLOB_CHUNK_LENGTH) },
        { t: 'blob-end' },
      ],
    ],
    ['a blob-chunk outside a unit', [{ t: 'blob-chunk', c: small }]],
    ['a blob-end outside a unit', [{ t: 'blob-end' }]],
    [
      'another answer inside a unit',
      [
        { t: 'blob-begin', id: blobId(small), size: 42 },
        { t: 'blob-missing', id: blobId(small) },
      ],
    ],
    [
      'a message of another stage inside a unit',
      [{ t: 'blob-begin', id: blobId(small), size: 42 }, { t: 'committed' }],
    ],
    ['a message of another stage', [{ t: 'records-end' }]],
    ['a blobs-want to B, who only asks', [{ t: 'blobs-want', ids: [blobId(small)] }]],
    ['a blobs-end to B, whose peer only answers', [{ t: 'blobs-end' }]],
  ])('aborts on %s (protocol-error), writing nothing', async (_case, messages) => {
    const { a, b } = pairing();
    const joined = joining(b, blobId(small), blobId(other));
    await a.receive();
    await a.receive();
    for (const message of messages) await a.send(message).catch(() => undefined);
    expect(await failure(joined.run)).toBe('protocol-error');
    expect(joined.store.written).toEqual([]);
    expect(joined.store.rejectedIds).toEqual([]);
  });

  it.each<[string, Message[]]>([
    [
      'a blobs-want after blobs-end',
      [{ t: 'blobs-end' }, { t: 'blobs-want', ids: [blobId(small)] }],
    ],
    ['a second blobs-end', [{ t: 'blobs-end' }, { t: 'blobs-end' }]],
  ])('aborts on %s from the asking side (protocol-error)', async (_case, messages) => {
    const { a, b } = pairing();
    const phase = new BlobPhase(a, answering(memoryBlobStore(small)));
    // A reader that keeps reading past blobs-end, as A's would while its answers leave.
    const reading = (async () => {
      for (;;) await phase.receive(await a.receive());
    })();
    for (const message of messages) await b.send(message).catch(() => undefined);
    expect(await failure(reading)).toBe('protocol-error');
  });

  it('writes nothing of a unit the end of the session cuts', async () => {
    const { a, b } = pairing();
    const joined = joining(b, blobId(large));
    await a.receive();
    await a.receive();
    await a.send({ t: 'blob-begin', id: blobId(large), size: large.length });
    await a.send({ t: 'blob-chunk', c: large.subarray(0, BLOB_CHUNK_LENGTH) });
    await a.abort('locked');
    expect(await failure(joined.run)).toBe('locked');
    expect(joined.store.written).toEqual([]);
    expect(joined.store.held.size).toBe(0);
  });

  it('aborts as protocol-error when the store fails, and keeps a session error over it', async () => {
    const { a, b } = pairing();
    const store = memoryBlobStore();
    store.cite(blobId(small));
    const broken: BlobStore = { ...store, write: () => Promise.reject(new Error('quota')) };
    const running = admissionBlobs(b, new BlobPhase(b, asking(broken)), true);
    await Promise.all([
      admissionBlobs(a, new BlobPhase(a, answering(memoryBlobStore(small))), false).catch(
        () => undefined,
      ),
      expect(failure(running)).resolves.toBe('protocol-error'),
    ]);

    const locked = pairing();
    const lockedStore: BlobStore = {
      ...memoryBlobStore(),
      lacking: async () => {
        await locked.b.abort('locked');
        throw new Error('the vault locked');
      },
    };
    expect(
      await failure(admissionBlobs(locked.b, new BlobPhase(locked.b, asking(lockedStore)), true)),
    ).toBe('locked');
  });

  it('ends a phase whose answers the end of the session cut with its error', async () => {
    const { a, b } = pairing();
    // A locks while it reads the blob, once B's blobs-end came: no answer leaves.
    const store: BlobStore = {
      ...memoryBlobStore(small),
      read: async (id) => {
        await vi.waitFor(() => {
          expect(phase.done).toBe(true);
        });
        await a.abort('locked');
        return memoryBlobStore(small).read(id);
      },
    };
    const phase = new BlobPhase(a, answering(store));
    const joined = joining(b, blobId(small));
    expect(await failure(admissionBlobs(a, phase, false))).toBe('locked');
    expect(await failure(joined.run)).toBe('locked');
    expect(joined.store.written).toEqual([]);
  });
});

describe('blob phase of a live sync (sync-protocol.md §10, §10.1)', () => {
  function liveOptions(store: BlobStore, merged: Uint8Array[][]): LiveOptions<string> {
    return {
      live: () => undefined,
      merge: (records) => {
        merged.push([...records]);
        return Promise.resolve('merged');
      },
      merged: () => Promise.resolve(),
      retired: () => Promise.resolve(),
      blobs: { store },
    };
  }

  /** Two sync sessions past both `committed`, each running its live session. */
  async function live(storeA: BlobStore, storeB: BlobStore) {
    const rec = recorder(decodeSyncMessage);
    const pair = memoryPair({ intercept: rec.intercept });
    const a = new SyncSession(pair.a);
    const b = new SyncSession(pair.b);
    await Promise.all([a.send({ t: 'committed' }), b.send({ t: 'committed' })]);
    const merged = { a: [] as Uint8Array[][], b: [] as Uint8Array[][] };
    const liveA = liveSession(a, liveOptions(storeA, merged.a));
    const liveB = liveSession(b, liveOptions(storeB, merged.b));
    void liveA.done.catch(() => undefined);
    void liveB.done.catch(() => undefined);
    return { a, b, liveA, liveB, merged, ...rec };
  }

  it('asks once live, then after each merged transfer for what it has not asked yet', async () => {
    const storeA = memoryBlobStore(small);
    const storeB = memoryBlobStore();
    storeB.cite(blobId(small), blobId(other));
    const { a, liveA, merged, sent } = await live(storeA, storeB);
    await vi.waitFor(() => {
      expect(sent('a-to-b').filter((m) => m.t === 'blob-missing')).toHaveLength(1);
    });
    expect(storeB.written.map(toHex)).toEqual([toHex(blobId(small))]);

    // A gets `other` and pushes a transfer that cites `large`: B asks for `large` alone, since
    // `other` was already asked for in this session.
    storeA.hold(other, large);
    storeB.cite(blobId(large));
    await liveA.push([Uint8Array.of(1)]);
    await vi.waitFor(() => {
      expect(storeB.written.map(toHex)).toEqual([blobId(small), blobId(large)].map(toHex));
    });
    expect(merged.b).toEqual([[Uint8Array.of(1)]]);
    const wants = sent('b-to-a').filter((m) => m.t === 'blobs-want');
    expect(wants).toHaveLength(2);
    expect(storeB.held.has(toHex(blobId(other)))).toBe(false);
    await a.abort('ended');
  });

  it('sends a unit and a transfer one after the other, never interleaved', async () => {
    const storeA = memoryBlobStore(large);
    const storeB = memoryBlobStore();
    storeB.cite(blobId(large));
    const { a, liveA, merged, sent } = await live(storeA, storeB);
    await vi.waitFor(() => {
      expect(sent('b-to-a').some((m) => m.t === 'blobs-want')).toBe(true);
    });
    await liveA.push([Uint8Array.of(7)]);
    await vi.waitFor(() => {
      expect(merged.b).toHaveLength(1);
      expect(storeB.written).toHaveLength(1);
    });
    const order = sent('a-to-b')
      .map((m) => m.t)
      .filter((t) => t !== 'committed');
    const begin = order.indexOf('blob-begin');
    expect(order.slice(begin, begin + 5)).toEqual([
      'blob-begin',
      'blob-chunk',
      'blob-chunk',
      'blob-chunk',
      'blob-end',
    ]);
    await a.abort('ended');
  });

  it('aborts on a transfer inside a unit (protocol-error), merging and writing nothing', async () => {
    const pair = memoryPair();
    const a = new SyncSession(pair.a);
    const b = new SyncSession(pair.b);
    await a.send({ t: 'committed' });
    const store = memoryBlobStore();
    store.cite(blobId(small));
    const merged: Uint8Array[][] = [];
    const running = liveSession(a, liveOptions(store, merged)).done;
    await b.send({ t: 'committed' });
    expect((await b.receive()).t).toBe('committed');
    expect((await b.receive()).t).toBe('blobs-want');
    await b.send({ t: 'blob-begin', id: blobId(small), size: small.length });
    await b.send({ t: 'records-begin', count: 0 });
    await b.send({ t: 'records-end' }).catch(() => undefined);
    expect(await failure(running)).toBe('protocol-error');
    expect(merged).toEqual([]);
    expect(store.written).toEqual([]);
  });

  it.each([
    ['a blobs-want before the peer’s committed', true],
    ['a blobs-end in a sync', false],
  ])('aborts on %s (protocol-error)', async (_case, early) => {
    const pair = memoryPair();
    const a = new SyncSession(pair.a);
    const b = new SyncSession(pair.b);
    await a.send({ t: 'committed' });
    const running = liveSession(a, liveOptions(memoryBlobStore(), [])).done;
    if (early) await b.send({ t: 'blobs-want', ids: [blobId(small)] });
    else {
      await b.send({ t: 'committed' });
      await b.send({ t: 'blobs-end' });
    }
    expect(await failure(running)).toBe('protocol-error');
  });
});
