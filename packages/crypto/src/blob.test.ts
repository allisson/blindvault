// Attachment blobs (attachments.md §2): the PyNaCl vectors of tests/vectors/generate.py, then the
// module's own edges.

import { beforeAll, describe, expect, it } from 'vitest';

import vectors from '../test-vectors/blob-v1.json' with { type: 'json' };
import {
  BLOB_ID_LENGTH,
  MAX_ATTACHMENT_SIZE,
  MAX_BLOB_LENGTH,
  MIN_BLOB_LENGTH,
  blobId,
  blobLength,
  blobMatches,
  openBlob,
  sealBlob,
} from './blob';
import { DecryptionError, EncodingError } from './errors';
import { initCrypto, lib } from './sodium';
import { fromHex, toHex } from './test-helpers';

beforeAll(initCrypto);

function filler(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.compare(a, b) === 0;
}

const key = fromHex(vectors.key);
const base = (i: number): Uint8Array => {
  const v = vectors.valid[i];
  if (v === undefined) throw new Error(`no valid vector ${String(i)}`);
  return new Uint8Array(Buffer.from(v.blob, 'base64'));
};

/** A blob of `size` bytes pushed with the given tags, one per chunk, for the tag rules. */
function withTags(size: number, tags: readonly number[]): Uint8Array {
  const sodium = lib();
  const k = new Uint8Array(32).fill(9);
  const { state, header } = sodium.crypto_secretstream_xchacha20poly1305_init_push(k);
  const pt = filler(size);
  const parts = [header];
  tags.forEach((tag, i) => {
    const chunk = pt.subarray(i * 65_536, Math.min(size, (i + 1) * 65_536));
    parts.push(sodium.crypto_secretstream_xchacha20poly1305_push(state, chunk, null, tag));
  });
  return new Uint8Array(Buffer.concat(parts));
}

describe('PyNaCl vectors', () => {
  it.each(vectors.valid.map((v, i) => [v.size, i] as const))(
    'opens the %i-byte blob and agrees on its blobId',
    (size, i) => {
      const blob = base(i);
      expect(toHex(blobId(blob))).toBe(vectors.valid[i]?.blobId);
      expect(blobMatches(blob, fromHex(vectors.valid[i]?.blobId ?? ''))).toBe(true);
      expect(blob.length).toBe(blobLength(size));
      expect(same(openBlob(key, size, blob), filler(size))).toBe(true);
    },
  );

  it.each(vectors.rejected.map((c) => [c.case, c] as const))('refuses: %s', (_name, c) => {
    let blob = base(c.base);
    if ('flip' in c) {
      blob = blob.slice();
      blob[c.flip] = (blob[c.flip] ?? 0) ^ 1;
    }
    if ('keep' in c) blob = blob.slice(0, c.keep);
    if ('append' in c) blob = new Uint8Array([...blob, ...fromHex(c.append)]);
    const size = 'size' in c ? c.size : (vectors.valid[c.base]?.size ?? 0);
    const k = 'key' in c ? fromHex(c.key) : key;
    expect(() => openBlob(k, size, blob)).toThrow(DecryptionError);
  });
});

describe('sealBlob and openBlob', () => {
  it.each([1, 65_535, 65_536, 65_537, 3 * 65_536 + 5])('round-trips %i bytes', (size) => {
    const pt = filler(size);
    const sealed = sealBlob(pt);
    expect(sealed.blob.length).toBe(blobLength(size));
    expect(sealed.key.length).toBe(32);
    expect(same(sealed.blobId, blobId(sealed.blob))).toBe(true);
    expect(same(openBlob(sealed.key, size, sealed.blob), pt)).toBe(true);
  });

  it('round-trips the largest attachment, at the largest blob length', () => {
    const pt = filler(MAX_ATTACHMENT_SIZE);
    const sealed = sealBlob(pt);
    expect(sealed.blob.length).toBe(MAX_BLOB_LENGTH);
    expect(same(openBlob(sealed.key, MAX_ATTACHMENT_SIZE, sealed.blob), pt)).toBe(true);
  });

  it('draws a new key for every file, so one file gives two blobs', () => {
    const a = sealBlob(filler(10));
    const b = sealBlob(filler(10));
    expect(same(a.key, b.key)).toBe(false);
    expect(same(a.blobId, b.blobId)).toBe(false);
  });

  it('refuses an empty or oversized file', () => {
    expect(() => sealBlob(new Uint8Array(0))).toThrow(EncodingError);
    expect(() => sealBlob(new Uint8Array(MAX_ATTACHMENT_SIZE + 1))).toThrow(EncodingError);
  });

  it('refuses a key that is not 32 bytes and a size out of range', () => {
    const { blob, key: k } = sealBlob(filler(5));
    expect(() => openBlob(k.subarray(0, 31), 5, blob)).toThrow(EncodingError);
    expect(() => openBlob(k, 0, blob)).toThrow(EncodingError);
    expect(() => openBlob(k, MAX_ATTACHMENT_SIZE + 1, blob)).toThrow(EncodingError);
    expect(() => openBlob(k, 1.5, blob)).toThrow(EncodingError);
  });

  it('refuses every chunk tag but TAG_MESSAGE before the last and TAG_FINAL on it', () => {
    const s = lib();
    const MESSAGE = s.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
    const FINAL = s.crypto_secretstream_xchacha20poly1305_TAG_FINAL;
    const PUSH = s.crypto_secretstream_xchacha20poly1305_TAG_PUSH;
    const REKEY = s.crypto_secretstream_xchacha20poly1305_TAG_REKEY;
    const k = new Uint8Array(32).fill(9);
    const size = 65_537;
    expect(same(openBlob(k, size, withTags(size, [MESSAGE, FINAL])), filler(size))).toBe(true);
    for (const tags of [
      [FINAL, FINAL],
      [MESSAGE, MESSAGE],
      [PUSH, FINAL],
      [REKEY, FINAL],
      [MESSAGE, PUSH],
    ]) {
      expect(() => openBlob(k, size, withTags(size, tags))).toThrow(DecryptionError);
    }
  });
});

describe('blobLength, blobId and blobMatches', () => {
  it('gives the bounds of attachments.md §2', () => {
    expect(blobLength(1)).toBe(MIN_BLOB_LENGTH);
    expect(MIN_BLOB_LENGTH).toBe(42);
    expect(blobLength(MAX_ATTACHMENT_SIZE)).toBe(MAX_BLOB_LENGTH);
    expect(MAX_BLOB_LENGTH).toBe(10_488_521);
    expect(blobLength(65_536)).toBe(24 + 65_536 + 34);
    for (const size of [0, -1, MAX_ATTACHMENT_SIZE + 1, 2.5, Number.NaN]) {
      expect(() => blobLength(size)).toThrow(EncodingError);
    }
  });

  it('refuses to hash a blob out of range', () => {
    expect(() => blobId(new Uint8Array(MIN_BLOB_LENGTH - 1))).toThrow(EncodingError);
    expect(() => blobId(new Uint8Array(MAX_BLOB_LENGTH + 1))).toThrow(EncodingError);
    expect(blobId(new Uint8Array(MIN_BLOB_LENGTH)).length).toBe(BLOB_ID_LENGTH);
  });

  it('matches only a blob in range under its own 32-byte blobId', () => {
    const blob = base(0);
    const id = blobId(blob);
    const other = id.slice();
    other[0] = (other[0] ?? 0) ^ 1;
    expect(blobMatches(blob, other)).toBe(false);
    expect(blobMatches(blob, id.subarray(0, 31))).toBe(false);
    expect(blobMatches(blob.subarray(0, MIN_BLOB_LENGTH - 1), id)).toBe(false);
    const changed = blob.slice();
    changed[30] = (changed[30] ?? 0) ^ 1;
    expect(blobMatches(changed, id)).toBe(false);
  });
});
