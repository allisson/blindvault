import {
  MAX_BLOB_LENGTH,
  MAX_ENVELOPE_LENGTH,
  MIN_BLOB_LENGTH,
  encodeCbor,
} from '@blindvault/crypto';
import { describe, expect, it } from 'vitest';

import vectors from '../test-vectors/sync-v2.json' with { type: 'json' };
import { BLOB_CHUNK_LENGTH, MAX_BLOB_IDS } from './blob-messages';
import { MAX_PROTOCOL_MESSAGE_LENGTH } from './frames';
import { MessageError } from './message-codec';
import { decodeMessage } from './messages';
import {
  MAX_SUMMARY_ENTRIES,
  SYNC_ABORT_REASONS,
  type SummaryEntry,
  type SyncMessage,
  decodeSyncMessage,
  encodeSyncMessage,
} from './sync-messages';

const v = vectors.messages;
const hex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));
const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');

interface EntryJson {
  recordFormatVersion: number;
  recordType: number;
  recordId: string;
  hlc: { physicalMs: number; counter: number; deviceId: string };
  deleted: boolean;
  keyEpoch: number;
}

const entryOf = (e: EntryJson): SummaryEntry => ({
  ...e,
  recordId: hex(e.recordId),
  hlc: { ...e.hlc, deviceId: hex(e.hlc.deviceId) },
});

/** The message of a vector, without `v`, with its byte strings as bytes. */
function expected(json: Record<string, unknown>): SyncMessage {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(json)) {
    if (key === 'v') continue;
    if (key === 'r' || key === 'id' || key === 'c') out[key] = hex(value as string);
    else if (key === 'ids') out[key] = (value as string[]).map(hex);
    else if (key === 'e') out[key] = (value as EntryJson[]).map(entryOf);
    else out[key] = value;
  }
  return out as unknown as SyncMessage;
}

function rejection(bytes: Uint8Array): string {
  try {
    decodeSyncMessage(bytes);
  } catch (error) {
    if (error instanceof MessageError) return error.reason;
    throw error;
  }
  return 'accepted';
}

/** `{e: [entry × n], t: "summary", v: 2}` from one encoded entry, as the vectors give it. */
function summaryOf(entry: Uint8Array, n: number): Uint8Array {
  const head = [0xa3, 0x61, 0x65, ...(n < 24 ? [0x80 | n] : [0x99, n >> 8, n & 0xff])];
  const tail = [0x61, 0x74, 0x67, ...new TextEncoder().encode('summary'), 0x61, 0x76, 0x02];
  const bytes = new Uint8Array(head.length + entry.length * n + tail.length);
  bytes.set(head);
  for (let i = 0; i < n; i++) bytes.set(entry, head.length + i * entry.length);
  bytes.set(tail, bytes.length - tail.length);
  return bytes;
}

describe('sync messages (sync-protocol.md §11.1)', () => {
  it('knows the abort reasons of the vectors, in the order of §11.2', () => {
    expect(SYNC_ABORT_REASONS).toEqual(v.abortReasons);
    expect(MAX_SUMMARY_ENTRIES).toBe(v.maxSummaryEntries);
  });

  it.each(v.valid.map((c) => [c.case, c] as const))('decodes %s', (_case, c) => {
    expect(decodeSyncMessage(hex(c.bytes))).toEqual(expected(c.message));
  });

  it.each(v.valid.filter((c) => !c.case.includes('read as')).map((c) => [c.case, c] as const))(
    'encodes %s to the bytes of the vector',
    (_case, c) => {
      expect(encodeSyncMessage(expected(c.message))).toEqual(hex(c.bytes));
    },
  );

  it.each(v.invalid.map((c) => [c.case, c] as const))('rejects %s', (_case, c) => {
    expect(rejection(hex(c.bytes))).toBe(c.reason);
  });

  it('reads an unknown abort reason, or a pairing one, as protocol-error', () => {
    const read = v.valid.filter((c) => c.case.includes('read as'));
    expect(read).toHaveLength(2);
    for (const c of read) {
      expect(decodeSyncMessage(hex(c.bytes))).toEqual({ t: 'abort', reason: 'protocol-error' });
    }
  });

  it('takes a summary of 16,384 entries at their largest, below the message cap', () => {
    const largest = hex(v.largestEntry);
    expect(largest).toHaveLength(v.maxEntryLength);
    const bytes = summaryOf(largest, MAX_SUMMARY_ENTRIES);
    expect(bytes).toHaveLength(v.largestSummaryLength);
    expect(bytes.length).toBeLessThan(MAX_PROTOCOL_MESSAGE_LENGTH);
    const message = decodeSyncMessage(bytes);
    expect(message.t === 'summary' && message.e.length).toBe(MAX_SUMMARY_ENTRIES);
    expect(toHex(encodeSyncMessage(message))).toBe(toHex(bytes));
  });

  it('refuses a summary of 16,385 entries', () => {
    expect(rejection(summaryOf(hex(v.smallestEntry), MAX_SUMMARY_ENTRIES + 1))).toBe(
      'protocol-error',
    );
  });

  describe('the blob messages at their bounds (§10.1)', () => {
    /** A message map as the vectors encode it, with `v` 2, encoded without the codec's checks. */
    const raw = (t: string, key: string, value: Uint8Array | Uint8Array[]) =>
      encodeCbor(
        new Map<string, unknown>([
          [key, value],
          ['t', t],
          ['v', 2],
        ]) as Parameters<typeof encodeCbor>[0],
      );

    it('uses the bounds of the vectors', () => {
      expect(MAX_BLOB_IDS).toBe(v.maxBlobIds);
      expect(BLOB_CHUNK_LENGTH).toBe(v.blobChunkLength);
      expect(MIN_BLOB_LENGTH).toBe(v.minBlobLength);
      expect(MAX_BLOB_LENGTH).toBe(v.maxBlobLength);
    });

    it('takes a blobs-want of 16,384 IDs and refuses one of 16,385', () => {
      const ids = Array.from({ length: MAX_BLOB_IDS }, () => new Uint8Array(32));
      const bytes = encodeSyncMessage({ t: 'blobs-want', ids });
      expect(bytes).toHaveLength(v.largestBlobsWantLength);
      expect(bytes.length).toBeLessThanOrEqual(MAX_PROTOCOL_MESSAGE_LENGTH);
      const message = decodeSyncMessage(bytes);
      expect(message.t === 'blobs-want' && message.ids.length).toBe(MAX_BLOB_IDS);
      expect(rejection(raw('blobs-want', 'ids', [...ids, new Uint8Array(32)]))).toBe(
        'protocol-error',
      );
    });

    it('takes a blob-chunk of 1,048,576 bytes and refuses one of 1,048,577', () => {
      const bytes = encodeSyncMessage({ t: 'blob-chunk', c: new Uint8Array(BLOB_CHUNK_LENGTH) });
      expect(bytes).toHaveLength(v.largestBlobChunkLength);
      expect(bytes.length).toBeLessThanOrEqual(MAX_PROTOCOL_MESSAGE_LENGTH);
      const message = decodeSyncMessage(bytes);
      expect(message.t === 'blob-chunk' && message.c.length).toBe(BLOB_CHUNK_LENGTH);
      expect(rejection(raw('blob-chunk', 'c', new Uint8Array(BLOB_CHUNK_LENGTH + 1)))).toBe(
        'protocol-error',
      );
    });

    it('decodes the IDs of a blobs-want as copies', () => {
      const bytes = encodeSyncMessage({ t: 'blobs-want', ids: [new Uint8Array(32).fill(7)] });
      const message = decodeSyncMessage(bytes);
      bytes.fill(0);
      expect(message).toEqual({ t: 'blobs-want', ids: [new Uint8Array(32).fill(7)] });
    });
  });

  it('refuses to encode a message that decoding would reject', () => {
    const entry = entryOf(v.valid[3]?.message.e?.[0] as EntryJson);
    const bad: unknown[] = [
      { t: 'summary', e: [] },
      { t: 'summary', e: [{ ...entry, recordType: 0x10000 }] },
      { t: 'summary', e: [{ ...entry, recordId: new Uint8Array(15) }] },
      { t: 'summary', e: [{ ...entry, keyEpoch: 2 ** 32 }] },
      { t: 'summary', e: [{ ...entry, hlc: { ...entry.hlc, counter: -1 } }] },
      { t: 'retired', r: new Uint8Array(MAX_ENVELOPE_LENGTH + 1) },
      { t: 'abort', reason: 'cancelled' },
      { t: 'nonce', n: new Uint8Array(32) },
      { t: 'committed', extra: 1 },
      { t: 'blobs-want', ids: [] },
      { t: 'blob-begin', id: new Uint8Array(32), size: MIN_BLOB_LENGTH - 1 },
      { t: 'blob-chunk', c: new Uint8Array(0) },
      { t: 'blob-missing', id: new Uint8Array(31) },
    ];
    for (const message of bad) {
      expect(() => encodeSyncMessage(message as SyncMessage)).toThrow(MessageError);
    }
  });

  it('decodes byte strings as copies, so wiping the message bytes keeps the message', () => {
    const entry = entryOf(v.valid[3]?.message.e?.[0] as EntryJson);
    const bytes = encodeSyncMessage({ t: 'summary', e: [entry] });
    const retired = encodeSyncMessage({ t: 'retired', r: new Uint8Array(40).fill(4) });
    const summary = decodeSyncMessage(bytes);
    const record = decodeSyncMessage(retired);
    bytes.fill(0);
    retired.fill(0);
    expect(summary).toEqual({ t: 'summary', e: [entry] });
    expect(record).toEqual({ t: 'retired', r: new Uint8Array(40).fill(4) });
  });

  it('keeps the two protocols apart: a sync message is not a pairing one, and back', () => {
    const summaryEnd = encodeSyncMessage({ t: 'summary-end' });
    expect(() => decodeMessage(summaryEnd)).toThrow(MessageError);
    const ended = encodeSyncMessage({ t: 'abort', reason: 'ended' });
    // A pairing device reads a sync reason as protocol-error, as any unknown reason.
    expect(decodeMessage(ended)).toEqual({ t: 'abort', reason: 'protocol-error' });
  });
});
