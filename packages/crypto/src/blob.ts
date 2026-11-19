// Attachment blobs (attachments.md §2, D278): a file encrypted with `secretstream` under a random
// key of its own, cut as the backup stream, with no additional data, and named by the BLAKE2b-256
// of its bytes as stored.

import type { StateAddress } from 'libsodium-wrappers-sumo';

import { DecryptionError, EncodingError } from './errors';
import { lib } from './sodium';

export const BLOB_KEY_LENGTH = 32;
export const BLOB_ID_LENGTH = 32;
/** The largest attachment, in plaintext bytes (10 MiB). */
export const MAX_ATTACHMENT_SIZE = 10_485_760;
const HEADER = 24;
const CHUNK = 65_536;
const ABYTES = 17;
/** A 1-byte file: the stream header, the byte and one final chunk's tag. */
export const MIN_BLOB_LENGTH = HEADER + 1 + ABYTES;
/** A 10 MiB file: 160 full chunks and an empty final one. */
export const MAX_BLOB_LENGTH =
  HEADER + MAX_ATTACHMENT_SIZE + ABYTES * (MAX_ATTACHMENT_SIZE / CHUNK + 1);

export interface SealedBlob {
  readonly blob: Uint8Array;
  readonly blobId: Uint8Array;
  /** The blob's key, for the item's `attachment` field; the caller wipes it once written. */
  readonly key: Uint8Array;
}

function checkSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_ATTACHMENT_SIZE) {
    throw new EncodingError('attachment size out of range');
  }
}

/** The length of the blob of a `size`-byte file. */
export function blobLength(size: number): number {
  checkSize(size);
  return HEADER + size + ABYTES * (Math.floor(size / CHUNK) + 1);
}

function inRange(blob: Uint8Array): boolean {
  return blob.length >= MIN_BLOB_LENGTH && blob.length <= MAX_BLOB_LENGTH;
}

/** The `blobId` of a blob: BLAKE2b-256 of its bytes. A length out of range throws. */
export function blobId(blob: Uint8Array): Uint8Array {
  if (!inRange(blob)) throw new EncodingError('blob length out of range');
  return lib().crypto_generichash(BLOB_ID_LENGTH, blob, null);
}

/** Whether `blob` is in range and hashes to `id`, checked before a received blob is written. */
export function blobMatches(blob: Uint8Array, id: Uint8Array): boolean {
  if (id.length !== BLOB_ID_LENGTH || !inRange(blob)) return false;
  return lib().memcmp(blobId(blob), id);
}

/** Encrypts a file under a new random key. */
export function sealBlob(plaintext: Uint8Array): SealedBlob {
  const sodium = lib();
  const blob = new Uint8Array(blobLength(plaintext.length));
  const key = sodium.crypto_secretstream_xchacha20poly1305_keygen();
  const { state, header } = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
  blob.set(header, 0);
  const full = Math.floor(plaintext.length / CHUNK);
  for (let i = 0; i <= full; i++) {
    const start = i * CHUNK;
    const chunk = plaintext.subarray(start, i < full ? start + CHUNK : plaintext.length);
    const tag =
      i < full
        ? sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE
        : sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL;
    blob.set(
      sodium.crypto_secretstream_xchacha20poly1305_push(state, chunk, null, tag),
      HEADER + i * (CHUNK + ABYTES),
    );
  }
  return { blob, blobId: blobId(blob), key };
}

/**
 * Decrypts the blob of a `size`-byte file with its key. Anything but the exact layout of that size,
 * every chunk authenticating, `TAG_MESSAGE` on each but the last and `TAG_FINAL` on the last,
 * throws `DecryptionError`, so the plaintext is always `size` bytes.
 */
export function openBlob(key: Uint8Array, size: number, blob: Uint8Array): Uint8Array {
  if (key.length !== BLOB_KEY_LENGTH) throw new EncodingError('blob key is 32 bytes');
  if (blob.length !== blobLength(size)) throw new DecryptionError();
  const sodium = lib();
  let state: StateAddress;
  try {
    state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(blob.subarray(0, HEADER), key);
  } catch {
    throw new DecryptionError();
  }
  const plaintext = new Uint8Array(size);
  const full = Math.floor(size / CHUNK);
  try {
    for (let i = 0; i <= full; i++) {
      const start = HEADER + i * (CHUNK + ABYTES);
      const end = i < full ? start + CHUNK + ABYTES : blob.length;
      const expected =
        i < full
          ? sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE
          : sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL;
      let result;
      try {
        result = sodium.crypto_secretstream_xchacha20poly1305_pull(
          state,
          blob.subarray(start, end),
          null,
        );
      } catch {
        throw new DecryptionError();
      }
      if (result === false) throw new DecryptionError();
      try {
        if (result.tag !== expected) throw new DecryptionError();
        plaintext.set(result.message, i * CHUNK);
      } finally {
        sodium.memzero(result.message);
      }
    }
    return plaintext;
  } catch (error) {
    sodium.memzero(plaintext);
    throw error;
  }
}
