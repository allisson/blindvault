// The `.bvault` stream and payload (backup-format.md §5, §6, D95, D178). The payload holds the
// Master Key's bytes, so it is built and read here: key material never leaves this package.

import type { StateAddress } from 'libsodium-wrappers-sumo';

import { decodeCbor, encodeCbor } from './cbor';
import { DecryptionError, EncodingError } from './errors';
import { KEY_LENGTH, type Keyring, type SymmetricKey, adoptKey, keyBytes } from './keys';
import { ID_LENGTH, lib } from './sodium';

export const STREAM_HEADER_LENGTH = 24;
/** Plaintext bytes in every chunk but the final one. */
export const CHUNK_LENGTH = 65_536;
const ABYTES = 17;
const FULL_CHUNK = CHUNK_LENGTH + ABYTES;
export const MAX_META_LENGTH = 256;
/** The largest record envelope (crypto-spec.md §9.2). */
const MAX_RECORD_LENGTH = 1_049_130;
const META_KEYS = ['exportedAt', 'masterKey', 'recordCount', 'vaultId'];

/** What a backup's payload says about itself, verified once the whole stream authenticates. */
export interface BackupMeta {
  readonly vaultId: Uint8Array;
  readonly exportedAt: number;
}

export interface OpenedBackupPayload extends BackupMeta {
  /** The Master Key from the payload, owned by the keyring passed to `openBackupStream`. */
  readonly masterKey: SymmetricKey;
  /** Every record envelope exactly as stored, not yet verified (crypto-spec.md §9.5). */
  readonly records: Uint8Array[];
}

function u32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n);
  return out;
}

function safeUint(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Seals a payload as a `secretstream` under a file key. `header` is known before the file header
 * is encoded, since the file header holds it; `seal` then runs once with that file header as the
 * first chunk's additional data.
 */
export class BackupStreamWriter {
  readonly header: Uint8Array;
  readonly #state: StateAddress;
  #used = false;

  private constructor(fileKey: SymmetricKey) {
    const { state, header } = lib().crypto_secretstream_xchacha20poly1305_init_push(
      keyBytes(fileKey),
    );
    this.#state = state;
    this.header = header;
  }

  static create(fileKey: SymmetricKey): BackupStreamWriter {
    return new BackupStreamWriter(fileKey);
  }

  /** The stream body: `meta`, the Master Key and every record, in 64 KiB chunks (§5, §6). */
  seal(
    fileHeader: Uint8Array,
    meta: BackupMeta & { readonly masterKey: SymmetricKey },
    records: readonly Uint8Array[],
  ): Uint8Array {
    if (this.#used) throw new EncodingError('a backup stream seals once');
    this.#used = true;
    if (fileHeader.length === 0) throw new EncodingError('the file header is mandatory');
    if (meta.vaultId.length !== ID_LENGTH) throw new EncodingError('vaultId is 16 bytes');
    if (!safeUint(meta.exportedAt)) throw new EncodingError('exportedAt is a safe integer');
    for (const record of records) {
      if (record.length < 1 || record.length > MAX_RECORD_LENGTH) {
        throw new EncodingError('record length out of range');
      }
    }
    const metaBytes = encodeCbor(
      new Map<string, number | Uint8Array>([
        ['exportedAt', meta.exportedAt],
        ['masterKey', keyBytes(meta.masterKey)],
        ['recordCount', records.length],
        ['vaultId', meta.vaultId],
      ]),
    );
    const length = 4 + metaBytes.length + records.reduce((sum, r) => sum + 4 + r.length, 0);
    const payload = new Uint8Array(length);
    try {
      let pos = 0;
      for (const part of [metaBytes, ...records]) {
        payload.set(u32(part.length), pos);
        payload.set(part, pos + 4);
        pos += 4 + part.length;
      }
      const full = Math.floor(length / CHUNK_LENGTH);
      const finalLength = length - full * CHUNK_LENGTH;
      const body = new Uint8Array(full * FULL_CHUNK + finalLength + ABYTES);
      const sodium = lib();
      for (let i = 0; i <= full; i++) {
        const start = i * CHUNK_LENGTH;
        const chunk = payload.subarray(start, i < full ? start + CHUNK_LENGTH : length);
        const tag =
          i < full
            ? sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE
            : sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL;
        body.set(
          sodium.crypto_secretstream_xchacha20poly1305_push(
            this.#state,
            chunk,
            i === 0 ? fileHeader : null,
            tag,
          ),
          i * FULL_CHUNK,
        );
      }
      return body;
    } finally {
      lib().memzero(metaBytes);
      lib().memzero(payload);
    }
  }
}

/**
 * Pulls every chunk of `body` (§5): full chunks tagged `TAG_MESSAGE`, then one final chunk tagged
 * `TAG_FINAL`, the first with `fileHeader` as additional data. Any other shape, tag or failed
 * authentication, truncation and trailing bytes included, throws `DecryptionError`.
 */
function pull(
  fileKey: SymmetricKey,
  streamHeader: Uint8Array,
  fileHeader: Uint8Array,
  body: Uint8Array,
): Uint8Array {
  const sodium = lib();
  if (streamHeader.length !== STREAM_HEADER_LENGTH || fileHeader.length === 0) {
    throw new DecryptionError();
  }
  if (body.length < ABYTES) throw new DecryptionError();
  // Every chunk but the last is full; the last holds 17 to FULL_CHUNK - 1 bytes.
  const full = Math.floor((body.length - ABYTES) / FULL_CHUNK);
  const finalLength = body.length - full * FULL_CHUNK;
  if (finalLength < ABYTES || finalLength >= FULL_CHUNK) throw new DecryptionError();
  // Outside the try: a wiped key is `KeyWipedError`, never a damaged file.
  const key = keyBytes(fileKey);
  let state: StateAddress;
  try {
    state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(streamHeader, key);
  } catch {
    throw new DecryptionError();
  }
  const payload = new Uint8Array(full * CHUNK_LENGTH + finalLength - ABYTES);
  try {
    for (let i = 0; i <= full; i++) {
      const start = i * FULL_CHUNK;
      const chunk = body.subarray(start, i < full ? start + FULL_CHUNK : body.length);
      const expected =
        i < full
          ? sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE
          : sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL;
      let result;
      try {
        result = sodium.crypto_secretstream_xchacha20poly1305_pull(
          state,
          chunk,
          i === 0 ? fileHeader : null,
        );
      } catch {
        throw new DecryptionError();
      }
      if (result === false) throw new DecryptionError();
      try {
        if (result.tag !== expected) throw new DecryptionError();
        payload.set(result.message, i * CHUNK_LENGTH);
      } finally {
        sodium.memzero(result.message);
      }
    }
    return payload;
  } catch (error) {
    sodium.memzero(payload);
    throw error;
  }
}

/** Reads the authenticated payload (§6). Anything but its exact shape throws `EncodingError`. */
function parsePayload(keyring: Keyring, payload: Uint8Array): OpenedBackupPayload {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let pos = 0;
  const take = (max: number): Uint8Array => {
    if (pos + 4 > payload.length) throw new EncodingError('length prefix past the payload');
    const n = view.getUint32(pos);
    if (n < 1 || n > max || pos + 4 + n > payload.length) {
      throw new EncodingError('length out of range');
    }
    const out = payload.subarray(pos + 4, pos + 4 + n);
    pos += 4 + n;
    return out;
  };
  const meta = decodeCbor(take(MAX_META_LENGTH));
  if (
    !(meta instanceof Map) ||
    meta.size !== META_KEYS.length ||
    !META_KEYS.every((k) => meta.has(k))
  ) {
    throw new EncodingError('invalid backup meta');
  }
  const exportedAt = meta.get('exportedAt');
  const masterKey = meta.get('masterKey');
  const recordCount = meta.get('recordCount');
  const vaultId = meta.get('vaultId');
  if (
    !safeUint(exportedAt) ||
    !safeUint(recordCount) ||
    !(masterKey instanceof Uint8Array) ||
    masterKey.length !== KEY_LENGTH ||
    !(vaultId instanceof Uint8Array) ||
    vaultId.length !== ID_LENGTH
  ) {
    throw new EncodingError('invalid backup meta');
  }
  const records: Uint8Array[] = [];
  for (let i = 0; i < recordCount; i++) records.push(take(MAX_RECORD_LENGTH).slice());
  if (pos !== payload.length) throw new EncodingError('bytes after the last record');
  // The keyring takes a copy of its own; the decoded bytes are wiped with the payload.
  const key = adoptKey(keyring, masterKey.slice());
  lib().memzero(masterKey);
  return { vaultId: vaultId.slice(), exportedAt, masterKey: key, records };
}

/**
 * Opens a backup's stream with its file key. A stream that does not authenticate in full throws
 * `DecryptionError`; an authenticated payload of the wrong shape throws `EncodingError`. Nothing
 * is parsed before the final chunk authenticates, and the plaintext is wiped either way.
 */
export function openBackupStream(
  keyring: Keyring,
  fileKey: SymmetricKey,
  streamHeader: Uint8Array,
  fileHeader: Uint8Array,
  body: Uint8Array,
): OpenedBackupPayload {
  const payload = pull(fileKey, streamHeader, fileHeader, body);
  try {
    return parsePayload(keyring, payload);
  } finally {
    lib().memzero(payload);
  }
}
