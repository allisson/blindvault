// The blob messages of `sync-protocol.md` §11.1, shared by the sync and the pairing messages
// (`pairing-protocol.md` §10.2): the blob phase of §10.1 (D278, D279) runs in a sync and in an
// admission with the same messages and the same bounds.

import { BLOB_ID_LENGTH, MAX_BLOB_LENGTH, MIN_BLOB_LENGTH } from '@blindvault/crypto';

import { type Field, bytesField } from './message-codec';

/** The most IDs in one `blobs-want` (§10.1). */
export const MAX_BLOB_IDS = 16_384;

/** A `blob-chunk` holds exactly this many bytes, but the last of a blob, which holds 1 to this many. */
export const BLOB_CHUNK_LENGTH = 1_048_576;

export type BlobMessage =
  | { readonly t: 'blobs-want'; readonly ids: readonly Uint8Array[] }
  | { readonly t: 'blobs-end' }
  | { readonly t: 'blob-begin'; readonly id: Uint8Array; readonly size: number }
  | { readonly t: 'blob-chunk'; readonly c: Uint8Array }
  | { readonly t: 'blob-end' }
  | { readonly t: 'blob-missing'; readonly id: Uint8Array };

export type BlobMessageType = BlobMessage['t'];

const isId = (value: unknown): value is Uint8Array =>
  value instanceof Uint8Array && value.length === BLOB_ID_LENGTH;

const idsField: Field = {
  fits: (value) =>
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= MAX_BLOB_IDS &&
    value.every((id) => isId(id)),
  // The decoder's byte strings are views of the message bytes: copies, as for any other key.
  read: (value) => (value as Uint8Array[]).map((id) => id.slice()),
  write: (value) => [...(value as readonly Uint8Array[])],
};

const sizeField: Field = {
  fits: (value) =>
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= MIN_BLOB_LENGTH &&
    value <= MAX_BLOB_LENGTH,
};

const chunkField: Field = {
  fits: (value) =>
    value instanceof Uint8Array && value.length >= 1 && value.length <= BLOB_CHUNK_LENGTH,
};

/** The keys of each blob message besides `v` and `t`. */
export const BLOB_SCHEMA: Readonly<Record<BlobMessageType, Readonly<Record<string, Field>>>> = {
  'blobs-want': { ids: idsField },
  'blobs-end': {},
  'blob-begin': { id: bytesField(BLOB_ID_LENGTH), size: sizeField },
  'blob-chunk': { c: chunkField },
  'blob-end': {},
  'blob-missing': { id: bytesField(BLOB_ID_LENGTH) },
};

const BLOB_TYPES = new Set<string>(Object.keys(BLOB_SCHEMA));

/** Whether `message` is one of the blob messages of §10.1. */
export function isBlobMessage(message: { readonly t: string }): message is BlobMessage {
  return BLOB_TYPES.has(message.t);
}
