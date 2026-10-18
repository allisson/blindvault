// The summaries and the transfer of divergent records (`sync-protocol.md` §7 to §9, D222), over a
// real `Noise_KK` on the in-memory link.

import { Keyring, RecordType, generateDeviceIdentity, initCrypto } from '@blindvault/crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { type ExchangeOptions, SyncRefusal, exchange, selectRecords } from './exchange';
import { type MemoryPairOptions, memoryPair } from './memory';
import { IDLE_TIMEOUT_MS } from './channel-session';
import { MAX_SUMMARY_ENTRIES, type SummaryEntry } from './sync-messages';
import { syncHandshake } from './sync-handshake';
import { SyncError, SyncSession } from './sync-session';

beforeAll(initCrypto);

const T0 = 1_760_000_000_000;
const DEVICE_A = new Uint8Array(16).fill(0xa);
const DEVICE_B = new Uint8Array(16).fill(0xb);

function entry(
  recordType: number,
  id: number,
  physicalMs = T0,
  changes: Partial<SummaryEntry> = {},
): SummaryEntry {
  const recordId = new Uint8Array(16);
  new DataView(recordId.buffer).setUint32(0, id);
  return {
    recordFormatVersion: 1,
    recordType,
    recordId,
    hlc: { physicalMs, counter: 0, deviceId: DEVICE_A },
    deleted: false,
    keyEpoch: 1,
    ...changes,
  };
}

/** The envelope a test side holds for an entry: its type, id and time, so the peer can tell it. */
function envelopeOf(e: SummaryEntry): Uint8Array {
  const bytes = new Uint8Array(13);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, e.recordType);
  bytes.set(e.recordId.subarray(0, 4), 1);
  view.setFloat64(5, e.hlc.physicalMs);
  return bytes;
}

describe('what each side sends (sync-protocol.md §8)', () => {
  it('sends what the peer does not hold, and nothing of what only the peer holds', () => {
    const mine = [entry(RecordType.item, 1), entry(RecordType.folder, 2)];
    const theirs = [entry(RecordType.item, 1), entry(RecordType.item, 3), entry(0xfff0, 4)];
    expect(selectRecords(mine, theirs)).toEqual([entry(RecordType.folder, 2)]);
    expect(selectRecords(mine, [])).toEqual(mine);
    expect(selectRecords([], theirs)).toEqual([]);
  });

  it.each([RecordType.folder, RecordType.itemVersion])(
    'sends a record of type %i only when it wins last-write-wins against the peer’s entry',
    (type) => {
      const mine = entry(type, 1, T0);
      const send = (other: SummaryEntry) => selectRecords([mine], [other]).length === 1;
      expect(send(entry(type, 1, T0 - 1))).toBe(true);
      expect(send(entry(type, 1, T0, { hlc: { ...mine.hlc, counter: 1 } }))).toBe(false);
      expect(send(entry(type, 1, T0, { hlc: { ...mine.hlc, deviceId: DEVICE_B } }))).toBe(false);
      expect(
        send(entry(type, 1, T0, { hlc: { ...mine.hlc, deviceId: new Uint8Array(16).fill(1) } })),
      ).toBe(true);
      expect(send(entry(type, 1, T0 + 1))).toBe(false);
      // Equal HLCs: the higher format wins (D38); with that equal too, nothing is sent.
      expect(send(entry(type, 1, T0, { recordFormatVersion: 0 }))).toBe(true);
      expect(send(entry(type, 1, T0, { recordFormatVersion: 2 }))).toBe(false);
      expect(send(entry(type, 1, T0))).toBe(false);
      // A tombstone or another epoch with the same HLC and format is not sent: the residual risk.
      expect(send(entry(type, 1, T0, { deleted: true, keyEpoch: 2 }))).toBe(false);
    },
  );

  it('sends an Item whose HLC or format differs from the peer’s entry, older too, so both keep its loser (D6, D223)', () => {
    const mine = entry(RecordType.item, 1, T0);
    const send = (other: SummaryEntry) => selectRecords([mine], [other]).length === 1;
    expect(send(entry(RecordType.item, 1, T0 - 1))).toBe(true);
    expect(send(entry(RecordType.item, 1, T0 + 1))).toBe(true);
    expect(send(entry(RecordType.item, 1, T0, { hlc: { ...mine.hlc, counter: 1 } }))).toBe(true);
    expect(send(entry(RecordType.item, 1, T0, { hlc: { ...mine.hlc, deviceId: DEVICE_B } }))).toBe(
      true,
    );
    expect(send(entry(RecordType.item, 1, T0, { recordFormatVersion: 0 }))).toBe(true);
    expect(send(entry(RecordType.item, 1, T0, { recordFormatVersion: 2 }))).toBe(true);
    // Equal HLC and format: identical summaries, never sent, a tombstone or another epoch included.
    expect(send(entry(RecordType.item, 1, T0))).toBe(false);
    expect(send(entry(RecordType.item, 1, T0, { deleted: true, keyEpoch: 2 }))).toBe(false);
  });

  it.each([RecordType.device, RecordType.vaultKey, RecordType.recoveryEnvelope])(
    'sends a record of type %i whose entry differs from the peer’s in any field, older too (D31, D42, D44)',
    (type) => {
      const mine = entry(type, 1, T0);
      const send = (other: SummaryEntry) => selectRecords([mine], [other]).length === 1;
      expect(send(entry(type, 1, T0))).toBe(false);
      // A retired record reaches a peer holding a forged newer non-retired copy (D31).
      expect(send(entry(type, 1, T0 + 1))).toBe(true);
      expect(send(entry(type, 1, T0, { hlc: { ...mine.hlc, counter: 1 } }))).toBe(true);
      expect(send(entry(type, 1, T0, { hlc: { ...mine.hlc, deviceId: DEVICE_B } }))).toBe(true);
      expect(send(entry(type, 1, T0, { recordFormatVersion: 2 }))).toBe(true);
      expect(send(entry(type, 1, T0, { deleted: true }))).toBe(true);
      expect(send(entry(type, 1, T0, { keyEpoch: 2 }))).toBe(true);
    },
  );

  it('tells records apart by type and ID together (D158)', () => {
    const mine = [entry(RecordType.folder, 1), entry(RecordType.itemVersion, 1)];
    expect(selectRecords(mine, [entry(RecordType.folder, 1, T0 + 1)])).toEqual([
      entry(RecordType.itemVersion, 1),
    ]);
  });
});

/**
 * Two sessions after a real `Noise_KK` over the in-memory link. `bChannel` sends under b's session,
 * for the messages b's protocol would never send.
 */
async function sessions(options: MemoryPairOptions = {}) {
  const link = memoryPair(options);
  const keyring = new Keyring();
  const a = generateDeviceIdentity(keyring);
  const b = generateDeviceIdentity(keyring);
  const payload = (fill: number) => ({
    message: new Uint8Array(140).fill(fill),
    fingerprint: new Uint8Array(32).fill(fill + 1),
  });
  const both = { initiator: payload(0x10), responder: payload(0x30) };
  const [i, r] = await Promise.all([
    syncHandshake(link.a, { role: 'initiator', identity: a, peerPublicKey: b.publicKey, ...both }),
    syncHandshake(link.b, { role: 'responder', identity: b, peerPublicKey: a.publicKey, ...both }),
  ]);
  return { link, a: new SyncSession(i.channel), b: new SyncSession(r.channel) };
}

interface Side {
  readonly summary: readonly SummaryEntry[];
  readonly seen: { selected: SummaryEntry[][]; merged: Uint8Array[][]; retired: Uint8Array[] };
  readonly options: ExchangeOptions<string>;
}

function side(summary: readonly SummaryEntry[], overrides: Partial<ExchangeOptions<string>> = {}) {
  const seen: Side['seen'] = { selected: [], merged: [], retired: [] };
  const options: ExchangeOptions<string> = {
    summary,
    records: (selected) => {
      seen.selected.push([...selected]);
      return Promise.resolve(selected.map(envelopeOf));
    },
    merge: (records) => {
      seen.merged.push([...records]);
      return Promise.resolve(`merged ${String(records.length)}`);
    },
    retired: (envelope) => {
      seen.retired.push(envelope);
      return Promise.resolve();
    },
    ...overrides,
  };
  return { summary, seen, options };
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

describe('summaries and transfer (sync-protocol.md §7, §9, D222)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('exchanges both summaries, then sends each side what the other lacks or holds older, and differing Items both ways (D223)', async () => {
    const { a, b } = await sessions();
    const shared = entry(RecordType.item, 1, T0);
    const newerOnA = entry(RecordType.folder, 2, T0 + 5);
    const olderOnB = entry(RecordType.folder, 2, T0);
    const onlyOnB = entry(RecordType.folder, 3, T0);
    const itemOnA = entry(RecordType.item, 4, T0 + 5);
    const itemOnB = entry(RecordType.item, 4, T0);
    const sideA = side([shared, newerOnA, itemOnA]);
    const sideB = side([shared, olderOnB, onlyOnB, itemOnB]);
    const [ra, rb] = await Promise.all([exchange(a, sideA.options), exchange(b, sideB.options)]);
    expect([ra, rb]).toEqual(['merged 2', 'merged 2']);
    expect(sideA.seen.selected).toEqual([[newerOnA, itemOnA]]);
    expect(sideB.seen.selected).toEqual([[onlyOnB, itemOnB]]);
    expect(sideA.seen.merged).toEqual([[envelopeOf(onlyOnB), envelopeOf(itemOnB)]]);
    expect(sideB.seen.merged).toEqual([[envelopeOf(newerOnA), envelopeOf(itemOnA)]]);
    // committed is the app's to send, after the checks of §6: the session stays open.
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
  });

  it('sends a summary of more than one message, and an empty one, and an empty transfer', async () => {
    const { a, b } = await sessions();
    const many = Array.from({ length: MAX_SUMMARY_ENTRIES + 1 }, (_, i) =>
      entry(RecordType.item, i),
    );
    const sideA = side(many);
    const sideB = side([]);
    await Promise.all([exchange(a, sideA.options), exchange(b, sideB.options)]);
    expect(sideB.seen.merged[0]).toHaveLength(MAX_SUMMARY_ENTRIES + 1);
    expect(sideA.seen.merged).toEqual([[]]);
  });

  it('sends the summary in messages of at most 16,384 entries', async () => {
    const sizes: number[] = [];
    const { a, b } = await sessions();
    const many = Array.from({ length: MAX_SUMMARY_ENTRIES * 2 + 1 }, (_, i) =>
      entry(RecordType.item, i),
    );
    const reading = (async () => {
      const begin = await b.receive();
      expect(begin).toEqual({ t: 'summary-begin', count: many.length });
      for (;;) {
        const m = await b.receive();
        if (m.t !== 'summary') {
          expect(m.t).toBe('summary-end');
          return;
        }
        sizes.push(m.e.length);
      }
    })();
    void exchange(a, side(many).options).catch(() => undefined);
    await reading;
    expect(sizes).toEqual([MAX_SUMMARY_ENTRIES, MAX_SUMMARY_ENTRIES, 1]);
    await a.abort('ended');
  });

  /** b's side scripted message by message: a runs the exchange and must refuse. */
  async function refused(script: (b: SyncSession) => Promise<void>) {
    const { a, b } = await sessions();
    const sideA = side([entry(RecordType.item, 1)]);
    const running = exchange(a, sideA.options);
    await script(b).catch(() => undefined);
    const result = await failure(running);
    // b reads what a sent before its abort, then the abort.
    let peer: [string, string] | undefined;
    while (!peer) {
      try {
        await b.receive();
      } catch (error) {
        if (!(error instanceof SyncError)) throw error;
        peer = [error.reason, error.by];
      }
    }
    return { result, peer, merged: sideA.seen.merged };
  }

  const one = [entry(RecordType.item, 7)];
  it.each([
    [
      'fewer entries than count',
      async (b: SyncSession) => {
        await b.send({ t: 'summary-begin', count: 2 });
        await b.send({ t: 'summary', e: one });
        await b.send({ t: 'summary-end' });
      },
    ],
    [
      'more entries than count',
      async (b: SyncSession) => {
        await b.send({ t: 'summary-begin', count: 0 });
        await b.send({ t: 'summary', e: one });
      },
    ],
    [
      'two entries of one identity',
      async (b: SyncSession) => {
        await b.send({ t: 'summary-begin', count: 2 });
        await b.send({ t: 'summary', e: one });
        await b.send({ t: 'summary', e: [entry(RecordType.item, 7, T0 + 1)] });
      },
    ],
    [
      'a summary before summary-begin',
      async (b: SyncSession) => {
        await b.send({ t: 'summary', e: one });
      },
    ],
    [
      'records-begin before summary-end',
      async (b: SyncSession) => {
        await b.send({ t: 'summary-begin', count: 0 });
        await b.send({ t: 'records-begin', count: 0 });
      },
    ],
    [
      'a second summary-begin',
      async (b: SyncSession) => {
        await b.send({ t: 'summary-begin', count: 0 });
        await b.send({ t: 'summary-end' });
        await b.send({ t: 'summary-begin', count: 0 });
      },
    ],
    [
      'committed before the transfer',
      async (b: SyncSession) => {
        await b.send({ t: 'summary-begin', count: 0 });
        await b.send({ t: 'summary-end' });
        await b.send({ t: 'committed' });
      },
    ],
    [
      'fewer records than count',
      async (b: SyncSession) => {
        await b.send({ t: 'summary-begin', count: 0 });
        await b.send({ t: 'summary-end' });
        await b.send({ t: 'records-begin', count: 2 });
        await b.send({ t: 'record', r: Uint8Array.of(1) });
        await b.send({ t: 'records-end' });
      },
    ],
    [
      'more records than count',
      async (b: SyncSession) => {
        await b.send({ t: 'summary-begin', count: 0 });
        await b.send({ t: 'summary-end' });
        await b.send({ t: 'records-begin', count: 0 });
        await b.send({ t: 'record', r: Uint8Array.of(1) });
      },
    ],
    [
      'a record before records-begin',
      async (b: SyncSession) => {
        await b.send({ t: 'summary-begin', count: 0 });
        await b.send({ t: 'summary-end' });
        await b.send({ t: 'record', r: Uint8Array.of(1) });
      },
    ],
  ])('aborts on %s, merging nothing', async (_case, script) => {
    const { result, peer, merged } = await refused(script);
    expect(result).toEqual(['protocol-error', 'local']);
    expect(peer).toEqual(['protocol-error', 'remote']);
    expect(merged).toEqual([]);
  });

  it('aborts with the reason a callback refuses with, and with protocol-error for any other error', async () => {
    const run = async (records: ExchangeOptions<string>['records']) => {
      const { a, b } = await sessions();
      const sideA = side([entry(RecordType.item, 1)], { records });
      const sideB = side([]);
      const results = await Promise.all([
        failure(exchange(a, sideA.options)),
        failure(exchange(b, sideB.options)),
      ]);
      return { results, merged: sideB.seen.merged };
    };
    const refusal = await run(() => Promise.reject(new SyncRefusal('verification-failed')));
    expect(refusal.results).toEqual([
      ['verification-failed', 'local'],
      ['verification-failed', 'remote'],
    ]);
    expect(refusal.merged).toEqual([]);
    const other = await run(() => Promise.reject(new Error('boom')));
    expect(other.results).toEqual([
      ['protocol-error', 'local'],
      ['protocol-error', 'remote'],
    ]);
    expect(new SyncRefusal('protocol-error').message).toBe('sync refused (protocol-error)');
  });

  it.each([
    [
      'in place of the summary',
      async (b: SyncSession) => {
        await b.retire(Uint8Array.of(9));
      },
    ],
    [
      'during the transfer',
      async (b: SyncSession) => {
        await b.send({ t: 'summary-begin', count: 0 });
        await b.send({ t: 'summary-end' });
        await b.send({ t: 'records-begin', count: 1 });
        await b.retire(Uint8Array.of(9));
      },
    ],
  ])(
    'merges a retired sent %s, then ends with the peer’s abort (§6, D69, D220)',
    async (_case, script) => {
      const { a, b } = await sessions();
      const sideA = side([entry(RecordType.item, 1)]);
      const running = failure(exchange(a, sideA.options));
      await script(b);
      expect(await running).toEqual(['retired-peer', 'remote']);
      expect(sideA.seen.retired).toEqual([Uint8Array.of(9)]);
      expect(sideA.seen.merged).toEqual([]);
    },
  );

  it('aborts on a message after a retired, and with the reason the retired callback refuses with', async () => {
    const after = await sessions();
    const running = failure(exchange(after.a, side([]).options));
    await after.b.send({ t: 'retired', r: Uint8Array.of(9) });
    await after.b.send({ t: 'committed' });
    expect(await running).toEqual(['protocol-error', 'local']);

    const refused = await sessions();
    const sideA = side([], {
      retired: () => Promise.reject(new SyncRefusal('protocol-error')),
    });
    const refusing = failure(exchange(refused.a, sideA.options));
    await refused.b.retire(Uint8Array.of(9));
    // The peer's abort may already be in: either way the session ends and nothing merges.
    expect((await refusing)[0]).toMatch(/^(protocol-error|retired-peer)$/);
    expect(sideA.seen.merged).toEqual([]);
  });

  it('keeps the reason of a session that ended while a callback ran (D93)', async () => {
    for (const thrown of ['session', 'other'] as const) {
      const { a, b } = await sessions();
      const sideA = side([entry(RecordType.item, 1)], {
        records: async () => {
          const error = await a.abort('locked');
          throw thrown === 'session' ? error : new Error('vault locked');
        },
      });
      const results = await Promise.all([
        failure(exchange(a, sideA.options)),
        failure(exchange(b, side([]).options)),
      ]);
      expect(results).toEqual([
        ['locked', 'local'],
        ['locked', 'remote'],
      ]);
    }
  });

  it('merges nothing once the session ended before the merge', async () => {
    const { a, b } = await sessions();
    const sideA = side([entry(RecordType.item, 1)]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sideB = side([], {
      records: async (selected) => {
        await gate;
        return selected.map(envelopeOf);
      },
    });
    const running = [exchange(a, sideA.options), exchange(b, sideB.options)];
    // a received b's empty transfer only after b's gate: a lock on a before that ends both.
    await a.abort('locked');
    release();
    expect(await failure(running[0] as Promise<unknown>)).toEqual(['locked', 'local']);
    expect(await failure(running[1] as Promise<unknown>)).toEqual(['locked', 'remote']);
    expect(sideA.seen.merged).toEqual([]);
    expect(sideB.seen.merged).toEqual([]);
  });

  it('aborts as expired after 60 seconds without a frame, until the peer committed (§12)', async () => {
    const { a, b } = await sessions();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const running = failure(exchange(a, side([]).options));
    const peer = b.receive();
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1);
    expect(a.error).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(await running).toEqual(['expired', 'local']);
    // b had read a's summary-begin first.
    expect(await peer).toEqual({ t: 'summary-begin', count: 0 });
  });

  it('leaves the live session with no timeout (§12)', async () => {
    const { a, b } = await sessions();
    await Promise.all([exchange(a, side([]).options), exchange(b, side([]).options)]);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    a.live();
    const waiting = a.receive();
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS * 5);
    expect(a.error).toBeNull();
    await b.send({ t: 'committed' });
    expect(await waiting).toEqual({ t: 'committed' });
  });
});
