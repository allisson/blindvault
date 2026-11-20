// The `.bvault` stream and payload (backup-format.md §5, §6, D95, D178, D278). The payload holds
// the Master Key's bytes, so it is built and read here: key material never leaves this package.

import type { StateAddress } from 'libsodium-wrappers-sumo';

import { BLOB_ID_LENGTH, MAX_BLOB_LENGTH, MIN_BLOB_LENGTH, blobId } from './blob';
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

function u32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n);
  return out;
}

function safeUint(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** What a version-2 payload's `meta` holds besides `vaultId` and `exportedAt` (§6). */
export interface BackupPayloadMeta extends BackupMeta {
  readonly masterKey: SymmetricKey;
  readonly recordCount: number;
  readonly blobCount: number;
}

/**
 * Seals a version-2 payload as a `secretstream` under a file key, in parts. `header` is known
 * before the file header is encoded, since the file header holds it: `begin` with that file header
 * as the first chunk's additional data, `add` for each envelope then each blob, and `end`; each
 * returns the encrypted chunks it closed, so the payload is never held whole.
 */
export class BackupStreamWriter {
  readonly header: Uint8Array;
  readonly #state: StateAddress;
  #used = false;
  #fileHeader?: Uint8Array;
  /** The plaintext of the chunk being filled: `meta` holds the Master Key, so it is wiped. */
  readonly #buffer = new Uint8Array(CHUNK_LENGTH);
  #filled = 0;
  #pushed = 0;
  #records = 0;
  #blobs = 0;
  #ended = false;

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

  /** Starts a version-2 payload with its `meta` (§6); `recordCount` and `blobCount` parts follow. */
  begin(fileHeader: Uint8Array, meta: BackupPayloadMeta): Uint8Array[] {
    if (this.#used) throw new EncodingError('a backup stream seals once');
    this.#used = true;
    if (fileHeader.length === 0) throw new EncodingError('the file header is mandatory');
    if (meta.vaultId.length !== ID_LENGTH) throw new EncodingError('vaultId is 16 bytes');
    if (!safeUint(meta.exportedAt) || !safeUint(meta.recordCount) || !safeUint(meta.blobCount)) {
      throw new EncodingError('exportedAt and the counts are safe integers');
    }
    this.#fileHeader = fileHeader;
    this.#records = meta.recordCount;
    this.#blobs = meta.blobCount;
    const metaBytes = encodeCbor(
      new Map<string, number | Uint8Array>([
        ['blobCount', meta.blobCount],
        ['exportedAt', meta.exportedAt],
        ['masterKey', keyBytes(meta.masterKey)],
        ['recordCount', meta.recordCount],
        ['vaultId', meta.vaultId],
      ]),
    );
    try {
      return this.#write(metaBytes);
    } finally {
      lib().memzero(metaBytes);
    }
  }

  /** The next part: each of the `recordCount` envelopes, then each of the `blobCount` blobs. */
  add(part: Uint8Array): Uint8Array[] {
    if (!this.#fileHeader || this.#ended) throw new EncodingError('the payload is not open');
    if (this.#records > 0) {
      if (part.length < 1 || part.length > MAX_RECORD_LENGTH) {
        throw new EncodingError('record length out of range');
      }
      this.#records--;
    } else if (this.#blobs > 0) {
      if (part.length < MIN_BLOB_LENGTH || part.length > MAX_BLOB_LENGTH) {
        throw new EncodingError('blob length out of range');
      }
      this.#blobs--;
    } else {
      throw new EncodingError('more parts than meta counts');
    }
    return this.#write(part);
  }

  /** The final chunk, once every part counted in `meta` was added; the writer is then wiped. */
  end(): Uint8Array[] {
    if (!this.#fileHeader || this.#ended) throw new EncodingError('the payload is not open');
    if (this.#records > 0 || this.#blobs > 0)
      throw new EncodingError('fewer parts than meta counts');
    const final = this.#push(
      this.#buffer.subarray(0, this.#filled),
      lib().crypto_secretstream_xchacha20poly1305_TAG_FINAL,
    );
    this.wipe();
    return [final];
  }

  /** Wipes the chunk being filled; the writer then refuses every call. */
  wipe(): void {
    this.#used = true;
    this.#ended = true;
    lib().memzero(this.#buffer);
  }

  /** `u32 len ‖ bytes` into the buffer, pushing each chunk it fills with `TAG_MESSAGE`. */
  #write(bytes: Uint8Array): Uint8Array[] {
    const out: Uint8Array[] = [];
    const prefix = u32(bytes.length);
    for (const piece of [prefix, bytes]) {
      let pos = 0;
      while (pos < piece.length) {
        const n = Math.min(piece.length - pos, CHUNK_LENGTH - this.#filled);
        this.#buffer.set(piece.subarray(pos, pos + n), this.#filled);
        this.#filled += n;
        pos += n;
        if (this.#filled === CHUNK_LENGTH) {
          out.push(
            this.#push(this.#buffer, lib().crypto_secretstream_xchacha20poly1305_TAG_MESSAGE),
          );
          this.#filled = 0;
        }
      }
    }
    return out;
  }

  #push(plaintext: Uint8Array, tag: number): Uint8Array {
    const ad = this.#pushed === 0 ? (this.#fileHeader ?? null) : null;
    this.#pushed++;
    return lib().crypto_secretstream_xchacha20poly1305_push(this.#state, plaintext, ad, tag);
  }
}

// --- reading in two passes (§6, D278) --------------------------------------------------------

/** A `.bvault` file read by ranges, never whole: a `File` in the app. */
export interface BackupSource {
  readonly size: number;
  /** `length` bytes from `offset`; anything shorter is a damaged file. */
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** What the first pass learned of a payload, which the second pass must find again. */
export interface BackupScan {
  readonly version: 1 | 2;
  readonly size: number;
  /** The BLAKE2b-256 of every blob, in the file's order. */
  readonly blobIds: readonly Uint8Array[];
  /** BLAKE2b-256 of the payload from its start to the end of the last envelope. */
  readonly digest: Uint8Array;
}

export interface ReadBackupPayload extends BackupMeta {
  /** The Master Key from the payload, owned by the keyring passed to `readBackupStream`. */
  readonly masterKey: SymmetricKey;
  /** Every record envelope exactly as stored, not yet verified (crypto-spec.md §9.5). */
  readonly records: Uint8Array[];
  /** The blobs after the envelopes, read one at a time from where the envelopes end. */
  readonly blobs: BackupBlobReader;
}

export interface BackupBlobReader {
  /**
   * The next blob with its `blobId`, or `undefined` once every blob was read and the payload
   * ended. A blob or an end that differs from the first pass, the file having changed, throws
   * `DecryptionError`, and so does every later call.
   */
  next(): Promise<{ readonly blobId: Uint8Array; readonly blob: Uint8Array } | undefined>;
}

interface PayloadMeta {
  readonly vaultId: Uint8Array;
  readonly exportedAt: number;
  /** Decoded bytes: the caller copies and wipes them. */
  readonly masterKey: Uint8Array;
  readonly recordCount: number;
  readonly blobCount: number;
}

function parseMeta(bytes: Uint8Array, version: 1 | 2): PayloadMeta {
  const meta = decodeCbor(bytes);
  const keys = version === 1 ? META_KEYS : ['blobCount', ...META_KEYS];
  if (!(meta instanceof Map) || meta.size !== keys.length || !keys.every((k) => meta.has(k))) {
    throw new EncodingError('invalid backup meta');
  }
  const exportedAt = meta.get('exportedAt');
  const masterKey = meta.get('masterKey');
  const recordCount = meta.get('recordCount');
  const blobCount = version === 1 ? 0 : meta.get('blobCount');
  const vaultId = meta.get('vaultId');
  if (
    !safeUint(exportedAt) ||
    !safeUint(recordCount) ||
    !safeUint(blobCount) ||
    !(masterKey instanceof Uint8Array) ||
    masterKey.length !== KEY_LENGTH ||
    !(vaultId instanceof Uint8Array) ||
    vaultId.length !== ID_LENGTH
  ) {
    if (masterKey instanceof Uint8Array) lib().memzero(masterKey);
    throw new EncodingError('invalid backup meta');
  }
  // A copy: the decoded bytes may share `bytes`, which the caller wipes.
  const key = masterKey.slice();
  lib().memzero(masterKey);
  return { vaultId: vaultId.slice(), exportedAt, masterKey: key, recordCount, blobCount };
}

/**
 * The payload of a stream, pulled one chunk at a time from its source (§5): full chunks tagged
 * `TAG_MESSAGE`, then one final chunk tagged `TAG_FINAL`, the first with the file header as
 * additional data. A chunk that fails is `DecryptionError`; reading past the final chunk, or
 * bytes left after the payload's end, is `EncodingError`.
 */
class PayloadCursor {
  readonly #state: StateAddress;
  readonly #source: BackupSource;
  readonly #fileHeader: Uint8Array;
  readonly #full: number;
  #index = 0;
  #chunk: Uint8Array = new Uint8Array(0);
  #pos = 0;
  #hash: StateAddress | undefined;

  private constructor(
    state: StateAddress,
    source: BackupSource,
    fileHeader: Uint8Array,
    full: number,
  ) {
    this.#state = state;
    this.#source = source;
    this.#fileHeader = fileHeader;
    this.#full = full;
  }

  static open(
    fileKey: SymmetricKey,
    streamHeader: Uint8Array,
    fileHeader: Uint8Array,
    source: BackupSource,
  ): PayloadCursor {
    if (streamHeader.length !== STREAM_HEADER_LENGTH || fileHeader.length === 0) {
      throw new DecryptionError();
    }
    const body = source.size - fileHeader.length;
    if (body < ABYTES) throw new DecryptionError();
    // Every chunk but the last is full; the last holds 17 to FULL_CHUNK - 1 bytes.
    const full = Math.floor((body - ABYTES) / FULL_CHUNK);
    // Outside the try: a wiped key is `KeyWipedError`, never a damaged file.
    const key = keyBytes(fileKey);
    try {
      const state = lib().crypto_secretstream_xchacha20poly1305_init_pull(streamHeader, key);
      return new PayloadCursor(state, source, fileHeader, full);
    } catch {
      throw new DecryptionError();
    }
  }

  get #final(): boolean {
    return this.#index > this.#full;
  }

  /** Hashes every byte read from now on, until `digest`. */
  startDigest(): void {
    this.#hash = lib().crypto_generichash_init(null, 32);
  }

  digest(): Uint8Array {
    if (!this.#hash) throw new EncodingError('no digest started');
    const out = lib().crypto_generichash_final(this.#hash, 32);
    this.#hash = undefined;
    return out;
  }

  async #pull(): Promise<void> {
    if (this.#final) throw new EncodingError('length past the payload');
    const sodium = lib();
    const i = this.#index;
    const start = this.#fileHeader.length + i * FULL_CHUNK;
    const length = i < this.#full ? FULL_CHUNK : this.#source.size - start;
    // A read of another length fails to authenticate like any damaged chunk.
    const sealed = await this.#source.read(start, length);
    const expected =
      i < this.#full
        ? sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE
        : sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL;
    let result;
    try {
      result = sodium.crypto_secretstream_xchacha20poly1305_pull(
        this.#state,
        sealed,
        i === 0 ? this.#fileHeader : null,
      );
    } catch {
      throw new DecryptionError();
    }
    if (result === false) throw new DecryptionError();
    if (result.tag !== expected) {
      sodium.memzero(result.message);
      throw new DecryptionError();
    }
    sodium.memzero(this.#chunk);
    this.#chunk = result.message;
    this.#pos = 0;
    this.#index++;
  }

  /** `n` bytes, each piece handed to `sink` as it is read; the pieces are wiped after. */
  async read(n: number, sink: (piece: Uint8Array) => void): Promise<void> {
    let left = n;
    while (left > 0) {
      if (this.#pos === this.#chunk.length) await this.#pull();
      const piece = this.#chunk.subarray(
        this.#pos,
        this.#pos + Math.min(left, this.#chunk.length - this.#pos),
      );
      if (this.#hash) lib().crypto_generichash_update(this.#hash, piece);
      sink(piece);
      // Read bytes stay nowhere: `meta` holds the Master Key.
      lib().memzero(piece);
      this.#pos += piece.length;
      left -= piece.length;
    }
  }

  async take(n: number): Promise<Uint8Array> {
    const out = new Uint8Array(n);
    let at = 0;
    await this.read(n, (piece) => {
      out.set(piece, at);
      at += piece.length;
    });
    return out;
  }

  /** A length prefix: `EncodingError` unless within `min` to `max`. */
  async length(min: number, max: number): Promise<number> {
    const bytes = await this.take(4);
    const n = new DataView(bytes.buffer).getUint32(0);
    if (n < min || n > max) throw new EncodingError('length out of range');
    return n;
  }

  /** The payload's end: no byte left, the final chunk included. */
  async end(): Promise<void> {
    for (;;) {
      if (this.#pos < this.#chunk.length) throw new EncodingError('bytes after the payload');
      if (this.#final) return;
      await this.#pull();
    }
  }

  /** Pulls every chunk left, so a stream that fails to authenticate is told apart from a payload. */
  async drain(): Promise<void> {
    while (!this.#final) await this.#pull();
  }

  wipe(): void {
    lib().memzero(this.#chunk);
  }
}

function checkVersion(version: number): asserts version is 1 | 2 {
  if (version !== 1 && version !== 2) throw new EncodingError('unknown backup format version');
}

/**
 * The first pass (§6): pulls the whole stream, checking the payload's structure as it goes and
 * hashing each blob, and keeps only the `blobId`s. Nothing of the payload is held. A stream that
 * does not authenticate in full throws `DecryptionError`, which wins over a payload of the wrong
 * shape, `EncodingError`, a blob repeated included.
 */
export async function scanBackupStream(
  fileKey: SymmetricKey,
  version: number,
  streamHeader: Uint8Array,
  fileHeader: Uint8Array,
  source: BackupSource,
): Promise<BackupScan> {
  checkVersion(version);
  const size = source.size;
  const cursor = PayloadCursor.open(fileKey, streamHeader, fileHeader, source);
  try {
    cursor.startDigest();
    const metaBytes = await cursor.take(await cursor.length(1, MAX_META_LENGTH));
    let meta: PayloadMeta;
    try {
      meta = parseMeta(metaBytes, version);
    } finally {
      lib().memzero(metaBytes);
    }
    lib().memzero(meta.masterKey);
    for (let i = 0; i < meta.recordCount; i++) {
      await cursor.read(await cursor.length(1, MAX_RECORD_LENGTH), () => undefined);
    }
    const digest = cursor.digest();
    const blobIds: Uint8Array[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < meta.blobCount; i++) {
      const hash = lib().crypto_generichash_init(null, BLOB_ID_LENGTH);
      await cursor.read(await cursor.length(MIN_BLOB_LENGTH, MAX_BLOB_LENGTH), (piece) => {
        lib().crypto_generichash_update(hash, piece);
      });
      const id = lib().crypto_generichash_final(hash, BLOB_ID_LENGTH);
      const hex = lib().to_hex(id);
      if (seen.has(hex)) throw new EncodingError('the same blob twice');
      seen.add(hex);
      blobIds.push(id);
    }
    await cursor.end();
    return { version, size, blobIds, digest };
  } catch (error) {
    if (error instanceof EncodingError) await cursor.drain();
    throw error;
  } finally {
    cursor.wipe();
  }
}

/**
 * The second pass (§6): pulls the stream again from the start and decodes `meta` and the
 * envelopes, which must be those of the first pass, then hands over the blobs one at a time.
 * Anything that differs from `scan`, the file having changed between the passes, throws
 * `DecryptionError`. The Master Key goes to `keyring` only when the envelopes match. The file key
 * may be wiped once this returns: the blob reader holds only the stream's state.
 */
export async function readBackupStream(
  keyring: Keyring,
  fileKey: SymmetricKey,
  scan: BackupScan,
  streamHeader: Uint8Array,
  fileHeader: Uint8Array,
  source: BackupSource,
): Promise<ReadBackupPayload> {
  if (source.size !== scan.size) throw new DecryptionError();
  const cursor = PayloadCursor.open(fileKey, streamHeader, fileHeader, source);
  let meta: PayloadMeta | undefined;
  try {
    cursor.startDigest();
    const metaBytes = await cursor.take(await cursor.length(1, MAX_META_LENGTH));
    try {
      meta = parseMeta(metaBytes, scan.version);
    } finally {
      lib().memzero(metaBytes);
    }
    const records: Uint8Array[] = [];
    for (let i = 0; i < meta.recordCount; i++) {
      records.push(await cursor.take(await cursor.length(1, MAX_RECORD_LENGTH)));
    }
    if (meta.blobCount !== scan.blobIds.length || !lib().memcmp(cursor.digest(), scan.digest)) {
      throw new DecryptionError();
    }
    const masterKey = adoptKey(keyring, meta.masterKey.slice());
    return {
      vaultId: meta.vaultId,
      exportedAt: meta.exportedAt,
      masterKey,
      records,
      blobs: blobReader(cursor, scan.blobIds),
    };
  } catch (error) {
    cursor.wipe();
    if (error instanceof EncodingError) throw new DecryptionError();
    throw error;
  } finally {
    if (meta) lib().memzero(meta.masterKey);
  }
}

function blobReader(cursor: PayloadCursor, blobIds: readonly Uint8Array[]): BackupBlobReader {
  let next = 0;
  let failed = false;
  let done = false;
  return {
    async next() {
      if (failed) throw new DecryptionError();
      if (done) return undefined;
      try {
        const id = blobIds[next];
        if (id === undefined) {
          await cursor.end();
          done = true;
          cursor.wipe();
          return undefined;
        }
        const blob = await cursor.take(await cursor.length(MIN_BLOB_LENGTH, MAX_BLOB_LENGTH));
        if (!lib().memcmp(blobId(blob), id)) throw new DecryptionError();
        next++;
        return { blobId: id.slice(), blob };
      } catch (error) {
        failed = true;
        cursor.wipe();
        if (error instanceof EncodingError) throw new DecryptionError();
        throw error;
      }
    },
  };
}
