// The sync messages of `sync-protocol.md` §11.1, under the strict codec shared with the pairing
// messages (`message-codec.ts`). `records-begin`, `record` and `records-end` are those of the full
// transfer (§2.1); a `summary` entry is the CBOR array of §7, each element checked against its
// range. The order of the messages is each stage's to check (§11.1), not the codec's.

import { type CborValue, type Hlc, hlcValue, readHlc } from '@blindvault/crypto';

import {
  type Field,
  type MessageCodec,
  countField,
  decodeWith,
  encodeWith,
  envelopeField,
  textField,
} from './message-codec';

/** The reasons of §11.2, in its order. */
export const SYNC_ABORT_REASONS = [
  'ended',
  'locked',
  'expired',
  'retired-peer',
  'verification-failed',
  'version',
  'protocol-error',
] as const;

export type SyncAbortReason = (typeof SYNC_ABORT_REASONS)[number];

/** The most entries in one `summary` message (§7). */
export const MAX_SUMMARY_ENTRIES = 16_384;

const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;
const ID_LENGTH = 16;

/** One record as a summary lists it (§7): the six fields of its header. */
export interface SummaryEntry {
  readonly recordFormatVersion: number;
  readonly recordType: number;
  readonly recordId: Uint8Array;
  readonly hlc: Hlc;
  readonly deleted: boolean;
  readonly keyEpoch: number;
}

export type SyncMessage =
  | { readonly t: 'summary-begin'; readonly count: number }
  | { readonly t: 'summary'; readonly e: readonly SummaryEntry[] }
  | { readonly t: 'summary-end' }
  | { readonly t: 'records-begin'; readonly count: number }
  | { readonly t: 'record'; readonly r: Uint8Array }
  | { readonly t: 'records-end' }
  | { readonly t: 'committed' }
  | { readonly t: 'retired'; readonly r: Uint8Array }
  | { readonly t: 'abort'; readonly reason: SyncAbortReason };

export type SyncMessageType = SyncMessage['t'];

const isUint = (value: CborValue | undefined, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;

/**
 * An entry of §7, or `null` when out of its ranges: `recordFormatVersion` and `recordType` up to
 * 65,535, `recordId` 16 bytes, `hlc` as in a record header, `deleted` a bool, `keyEpoch` up to
 * 2³² − 1. An unknown format or type is not refused: it only tells what the peer holds.
 */
function readEntry(value: CborValue): SummaryEntry | null {
  if (!Array.isArray(value) || value.length !== 6) return null;
  const [recordFormatVersion, recordType, recordId, hlcItem, deleted, keyEpoch] = value;
  const hlc = readHlc(hlcItem);
  if (
    !isUint(recordFormatVersion, U16_MAX) ||
    !isUint(recordType, U16_MAX) ||
    !(recordId instanceof Uint8Array && recordId.length === ID_LENGTH) ||
    !hlc ||
    typeof deleted !== 'boolean' ||
    !isUint(keyEpoch, U32_MAX)
  ) {
    return null;
  }
  return { recordFormatVersion, recordType, recordId: recordId.slice(), hlc, deleted, keyEpoch };
}

const entriesField: Field = {
  fits: (value) =>
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= MAX_SUMMARY_ENTRIES &&
    value.every((entry) => readEntry(entry) !== null),
  read: (value) => (value as CborValue[]).map(readEntry),
  write: (value) =>
    (value as readonly SummaryEntry[]).map((entry) => [
      entry.recordFormatVersion,
      entry.recordType,
      entry.recordId,
      hlcValue(entry.hlc),
      entry.deleted,
      entry.keyEpoch,
    ]),
};

const SYNC: MessageCodec<SyncMessage> = {
  schema: {
    'summary-begin': { count: countField },
    summary: { e: entriesField },
    'summary-end': {},
    'records-begin': { count: countField },
    record: { r: envelopeField },
    'records-end': {},
    committed: {},
    retired: { r: envelopeField },
    abort: { reason: textField },
  },
  abortReasons: SYNC_ABORT_REASONS,
};

/** Encodes a sync message, refusing one that decoding would reject. */
export function encodeSyncMessage(message: SyncMessage): Uint8Array {
  return encodeWith(SYNC, message);
}

/**
 * Decodes a sync message under the rules of §11.1. Throws `MessageError`. Its byte strings are
 * copies: `bytes` can be wiped once decoded.
 */
export function decodeSyncMessage(bytes: Uint8Array): SyncMessage {
  return decodeWith(SYNC, bytes);
}
