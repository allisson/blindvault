// The summaries and the transfer of divergent records of a sync session (`sync-protocol.md` §7 to
// §9, D222), run once `Noise_KK` completed and the peer is known not to be retired (§6). Both sides
// send their summary at the same time, select what the peer lacks or holds older (§8), send it as
// one transfer while receiving the peer's, and merge what they received. This package never sees
// the vault: the records and the merge are callbacks the app wires to the vault session, and a
// callback refuses with an abort reason of §11.2 by throwing `SyncRefusal`. The `committed` that
// follows the merge is the app's to send, after the checks of §6 (D69, D220).

import { RecordType } from '@blindvault/crypto';

import {
  MAX_SUMMARY_ENTRIES,
  type SummaryEntry,
  type SyncAbortReason,
  type SyncMessage,
} from './sync-messages';
import { SyncError, type SyncSession } from './sync-session';

/** Thrown by a callback to abort the session with `reason`; any other error aborts as `protocol-error`. */
export class SyncRefusal extends Error {
  override name = 'SyncRefusal';
  constructor(
    readonly reason: SyncAbortReason,
    options?: ErrorOptions,
  ) {
    super(`sync refused (${reason})`, options);
  }
}

/** The types sent whenever the peer's entry differs in any field, older or not (§8, D31, D42, D44). */
const COMPARED_WHOLE = new Set<number>([
  RecordType.device,
  RecordType.vaultKey,
  RecordType.recoveryEnvelope,
]);

function hex(bytes: Uint8Array): string {
  let text = '';
  for (const b of bytes) text += b.toString(16).padStart(2, '0');
  return text;
}

function identity(entry: SummaryEntry): string {
  return `${String(entry.recordType)}:${hex(entry.recordId)}`;
}

/** The HLC order of D19: `physicalMs`, then `counter`, then the 16-byte `deviceId` bytewise. */
function compareHlc(a: SummaryEntry['hlc'], b: SummaryEntry['hlc']): number {
  if (a.physicalMs !== b.physicalMs) return a.physicalMs - b.physicalMs;
  if (a.counter !== b.counter) return a.counter - b.counter;
  // Hex of two IDs of one length orders as their bytes do.
  const x = hex(a.deviceId);
  const y = hex(b.deviceId);
  return x < y ? -1 : x > y ? 1 : 0;
}

function sameEntry(a: SummaryEntry, b: SummaryEntry): boolean {
  return (
    a.recordFormatVersion === b.recordFormatVersion &&
    compareHlc(a.hlc, b.hlc) === 0 &&
    a.deleted === b.deleted &&
    a.keyEpoch === b.keyEpoch
  );
}

/**
 * §8: the entries of `mine` whose record goes to the peer: one the peer does not hold; an Item whose
 * `hlc` or `recordFormatVersion` differs from the peer's entry (D223); an Item Version or Folder that
 * wins last-write-wins against the peer's entry (§1.2); a Device, Vault Key or Recovery Envelope
 * record whose entry differs from the peer's in any field.
 */
export function selectRecords(
  mine: readonly SummaryEntry[],
  theirs: readonly SummaryEntry[],
): SummaryEntry[] {
  const peer = new Map(theirs.map((e) => [identity(e), e]));
  return mine.filter((e) => {
    const other = peer.get(identity(e));
    if (!other) return true;
    if (COMPARED_WHOLE.has(e.recordType)) return !sameEntry(e, other);
    // An older Item goes too, so the winner stores the same loser as the peer (D6, D223).
    if (e.recordType === RecordType.item) {
      return (
        compareHlc(e.hlc, other.hlc) !== 0 || e.recordFormatVersion !== other.recordFormatVersion
      );
    }
    const order = compareHlc(e.hlc, other.hlc);
    return order > 0 || (order === 0 && e.recordFormatVersion > other.recordFormatVersion);
  });
}

export interface ExchangeOptions<T> {
  /** §7: every record this device holds, but those kept aside as corrupt. */
  readonly summary: readonly SummaryEntry[];
  /** §8: the envelopes of `selected`, read again and verified (D181). */
  readonly records: (selected: readonly SummaryEntry[]) => Promise<readonly Uint8Array[]>;
  /** §9: merges the peer's records and records the completed sync, in one commit. */
  readonly merge: (records: readonly Uint8Array[]) => Promise<T>;
  /**
   * §6: merges a `retired` the peer sent in place of the next message, this device's own Device
   * record retired during the session (D69, D220); the peer's `abort` follows and ends the exchange.
   */
  readonly retired: (envelope: Uint8Array) => Promise<void>;
}

/** Runs a callback; when it fails, ends the session with the reason it gives. */
async function guarded<T>(session: SyncSession, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SyncError) throw error;
    // The session ended while the callback ran, a lock included (D93): its own reason stands.
    if (session.error) throw session.error;
    if (error instanceof SyncRefusal) return session.refuse(error.reason, error);
    return session.refuse('protocol-error', error);
  }
}

/**
 * The peer's next message. A `retired` may come in place of any (§6): it is merged, then the peer's
 * `abort` ends the session with its reason, and anything else is out of the protocol.
 */
async function next(
  session: SyncSession,
  options: Pick<ExchangeOptions<unknown>, 'retired'>,
): Promise<SyncMessage> {
  const message = await session.receive();
  if (message.t !== 'retired') return message;
  await guarded(session, () => options.retired(message.r));
  await session.receive();
  return session.refuse('protocol-error');
}

async function sendSummary(session: SyncSession, entries: readonly SummaryEntry[]): Promise<void> {
  await session.send({ t: 'summary-begin', count: entries.length });
  for (let i = 0; i < entries.length; i += MAX_SUMMARY_ENTRIES) {
    await session.send({ t: 'summary', e: entries.slice(i, i + MAX_SUMMARY_ENTRIES) });
  }
  await session.send({ t: 'summary-end' });
}

/**
 * §7: the peer's summary. A number of entries other than `count`, two entries of one identity, or a
 * message out of its order aborts (`protocol-error`).
 */
async function receiveSummary<T>(
  session: SyncSession,
  options: ExchangeOptions<T>,
): Promise<SummaryEntry[]> {
  const begin = await next(session, options);
  if (begin.t !== 'summary-begin') return session.refuse('protocol-error');
  const entries: SummaryEntry[] = [];
  const seen = new Set<string>();
  for (;;) {
    const message = await next(session, options);
    if (message.t === 'summary-end') {
      if (entries.length !== begin.count) return session.refuse('protocol-error');
      return entries;
    }
    if (message.t !== 'summary' || entries.length + message.e.length > begin.count) {
      return session.refuse('protocol-error');
    }
    for (const e of message.e) {
      const id = identity(e);
      if (seen.has(id)) return session.refuse('protocol-error');
      seen.add(id);
      entries.push(e);
    }
  }
}

async function sendRecords(session: SyncSession, records: readonly Uint8Array[]): Promise<void> {
  await session.send({ t: 'records-begin', count: records.length });
  for (const r of records) await session.send({ t: 'record', r });
  await session.send({ t: 'records-end' });
}

/** §9 with §2.1: the peer's records, unverified, in memory until `records-end`. */
async function receiveRecords(
  session: SyncSession,
  options: Pick<ExchangeOptions<unknown>, 'retired'>,
): Promise<Uint8Array[]> {
  const begin = await next(session, options);
  if (begin.t !== 'records-begin') return session.refuse('protocol-error');
  const records: Uint8Array[] = [];
  for (;;) {
    const message = await next(session, options);
    if (records.length < begin.count) {
      if (message.t !== 'record') return session.refuse('protocol-error');
      records.push(message.r);
    } else {
      if (message.t !== 'records-end') return session.refuse('protocol-error');
      return records;
    }
  }
}

/**
 * One side of §7 to §9 up to its merge, which `merge` commits. Rejects with `SyncError` before the
 * merge; a session that ended before it merges nothing. The 60-second wait of §12 starts here.
 */
export async function exchange<T>(session: SyncSession, options: ExchangeOptions<T>): Promise<T> {
  session.exchanging();
  const [, theirs] = await Promise.all([
    sendSummary(session, options.summary),
    receiveSummary(session, options),
  ]);
  const selected = selectRecords(options.summary, theirs);
  const records = await guarded(session, () => options.records(selected));
  const [, received] = await Promise.all([
    sendRecords(session, records),
    receiveRecords(session, options),
  ]);
  // An abort discards every record of a transfer not merged (§11.2). Both reads and sends just
  // succeeded, so only an end in between, which no test can time, reaches this.
  /* v8 ignore next */
  if (session.error) throw session.error;
  return guarded(session, () => options.merge(received));
}

export interface LiveOptions<T> {
  /** The peer's `committed` arrived: the session is live (§9, §12). */
  readonly live: () => void;
  /** §10: merges one transfer of the peer as §9 does, in one commit that records the sync (D34). */
  readonly merge: (records: readonly Uint8Array[]) => Promise<T>;
  /** Each transfer merged, in order: the next is read once this resolves (§6, D69, D220). */
  readonly merged: (result: T) => Promise<void>;
  /** §6: as for `exchange`. */
  readonly retired: (envelope: Uint8Array) => Promise<void>;
}

/** The live session of §10, once this device has sent its `committed`. */
export interface LiveSession {
  /**
   * Queues one transfer of §2.1, sent once every transfer queued before it has left, so the messages
   * of two never interleave. Rejects with `SyncError` once the session ended.
   */
  push(records: readonly Uint8Array[]): Promise<void>;
  /**
   * Reads the peer's `committed`, which makes the session live, then its transfers and `retired`,
   * until the session ends: rejects with its `SyncError`. Anything else aborts (`protocol-error`).
   */
  readonly done: Promise<never>;
}

/** §10 (D225): run after this device sent `committed`. */
export function liveSession<T>(session: SyncSession, options: LiveOptions<T>): LiveSession {
  let sending: Promise<void> = Promise.resolve();
  const push = (records: readonly Uint8Array[]): Promise<void> => {
    const run = sending.then(() => sendRecords(session, records));
    sending = run.catch(() => undefined);
    return run;
  };
  const done = (async (): Promise<never> => {
    const first = await next(session, options);
    if (first.t !== 'committed') return session.refuse('protocol-error');
    session.live();
    options.live();
    for (;;) {
      const records = await receiveRecords(session, options);
      const result = await guarded(session, () => options.merge(records));
      await guarded(session, () => options.merged(result));
    }
  })();
  return { push, done };
}
