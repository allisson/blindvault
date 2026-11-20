// The `.bvault` file (backup-format.md, D3, D78, D95, D178, D278): the cleartext header and its
// keyslots, around the stream and payload that `@blindvault/crypto` writes in parts and reads in
// two passes. Version 2 is written; versions 1 and 2 are read.

import {
  type BackupBlobReader,
  type BackupMeta,
  type BackupSource,
  BackupStreamWriter,
  type CborMap,
  type CborValue,
  DecryptionError,
  EncodingError,
  ID_LENGTH,
  KEY_LENGTH,
  type Keyring,
  NONCE_LENGTH,
  SALT_LENGTH,
  STREAM_HEADER_LENGTH,
  type Sealed,
  type SymmetricKey,
  TAG_LENGTH,
  decodeCbor,
  encodeCbor,
  readBackupStream,
  scanBackupStream,
} from '@blindvault/crypto';

import { BackupRejectedError } from './errors';

export const BACKUP_MAGIC = new Uint8Array([0x89, 0x42, 0x56, 0x41, 0x55, 0x4c, 0x54, 0x0a]);
export const BACKUP_FORMAT_VERSION = 2;
export const MAX_HEADER_LENGTH = 4096;
const PREFIX_LENGTH = BACKUP_MAGIC.length + 2 + 4;
/** `crypto_box_seal` of a 32-byte key: ephemeral public key, key and tag. */
const SEALED_KEY_LENGTH = 32 + KEY_LENGTH + TAG_LENGTH;
const WRAPPED_KEY_LENGTH = KEY_LENGTH + TAG_LENGTH;
const MIB = 1_048_576;

/** Export Argon2id parameters, fixed rather than calibrated (§4, D78). */
export const EXPORT_KDF = { memlimit: 64 * MIB, opslimit: 12 } as const;

const RECOVERY = 1;
const PASSWORD = 2;

export interface RecoveryKeyslot {
  readonly type: 'recovery';
  /** `crypto_box_seal(fileKey, keyslotPublicKey)`, 80 bytes. */
  readonly sealed: Uint8Array;
}

export interface PasswordKeyslot {
  readonly type: 'password';
  readonly salt: Uint8Array;
  readonly opslimit: number;
  readonly memlimit: number;
  /** The file key sealed under the Argon2id KEK. */
  readonly wrap: Sealed;
}

export type Keyslots = readonly [RecoveryKeyslot] | readonly [RecoveryKeyslot, PasswordKeyslot];

export interface BackupHeader {
  readonly phraseId: Uint8Array;
  readonly phraseCreatedAt: number;
  readonly keyslots: Keyslots;
  /** The `secretstream` header. */
  readonly stream: Uint8Array;
}

export interface ParsedBackup {
  readonly version: 1 | 2;
  /** Not authenticated until `openBackup` succeeds: show `phraseId` and its date as unverified. */
  readonly header: BackupHeader;
  /** The header bytes as read, the first chunk's additional data. */
  readonly headerBytes: Uint8Array;
  /** The whole file, which each pass of `openBackup` reads again. */
  readonly source: BackupSource;
}

/** The payload of an opened file: `meta`, every envelope, and the blobs to read in order (§6). */
export interface OpenedBackup extends BackupMeta {
  /** In the keyring passed to `openBackup`. */
  readonly masterKey: SymmetricKey;
  /** Every record envelope exactly as stored, not yet verified (crypto-spec.md §9.5). */
  readonly records: Uint8Array[];
  /** The BLAKE2b-256 of every blob, in the file's order; none in version 1. */
  readonly blobIds: readonly Uint8Array[];
  /** The blobs in that order; a file changed since the first pass throws `corrupt`. */
  readonly blobs: BackupBlobReader;
}

/** A file already in memory, read by ranges like any other. */
export function bytesSource(bytes: Uint8Array): BackupSource {
  return {
    size: bytes.length,
    read: (offset, length) => Promise.resolve(bytes.slice(offset, offset + length)),
  };
}

function malformed(): BackupRejectedError {
  return new BackupRejectedError('malformed');
}

function safeUint(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function bytesOf(value: unknown, length: number): value is Uint8Array {
  return value instanceof Uint8Array && value.length === length;
}

function hasExactly(map: CborMap, keys: readonly string[]): boolean {
  return map.size === keys.length && keys.every((k) => map.has(k));
}

/** Throws `malformed` unless `header` is exactly what §2 and §3 allow. */
function checkHeader(header: BackupHeader): void {
  const { phraseId, phraseCreatedAt, keyslots, stream } = header;
  if (
    !bytesOf(phraseId, ID_LENGTH) ||
    !safeUint(phraseCreatedAt) ||
    !bytesOf(stream, STREAM_HEADER_LENGTH) ||
    !Array.isArray(keyslots) ||
    keyslots.length < 1 ||
    keyslots.length > 2
  ) {
    throw malformed();
  }
  const [recovery, password] = keyslots as readonly (RecoveryKeyslot | PasswordKeyslot)[];
  if (recovery?.type !== 'recovery' || !bytesOf(recovery.sealed, SEALED_KEY_LENGTH)) {
    throw malformed();
  }
  if (
    password !== undefined &&
    (password.type !== 'password' ||
      !bytesOf(password.salt, SALT_LENGTH) ||
      !safeUint(password.opslimit) ||
      !safeUint(password.memlimit) ||
      !bytesOf(password.wrap.n, NONCE_LENGTH) ||
      !bytesOf(password.wrap.c, WRAPPED_KEY_LENGTH))
  ) {
    throw malformed();
  }
}

function keyslotMap(slot: RecoveryKeyslot | PasswordKeyslot): CborMap {
  if (slot.type === 'recovery') {
    return new Map<CborValue, CborValue>([
      ['t', RECOVERY],
      ['c', slot.sealed],
    ]);
  }
  return new Map<CborValue, CborValue>([
    ['t', PASSWORD],
    ['salt', slot.salt],
    ['ops', slot.opslimit],
    ['mem', slot.memlimit],
    ['n', slot.wrap.n],
    ['c', slot.wrap.c],
  ]);
}

/** The header bytes: magic, version, length and the deterministic CBOR map (§2). */
export function encodeHeader(header: BackupHeader): Uint8Array {
  checkHeader(header);
  const map = encodeCbor(
    new Map<CborValue, CborValue>([
      ['keyslots', header.keyslots.map(keyslotMap)],
      ['phraseCreatedAt', header.phraseCreatedAt],
      ['phraseId', header.phraseId],
      ['stream', header.stream],
    ]),
  );
  // `checkHeader` bounds every field, so the map stays far below MAX_HEADER_LENGTH.
  const out = new Uint8Array(PREFIX_LENGTH + map.length);
  out.set(BACKUP_MAGIC);
  const view = new DataView(out.buffer);
  view.setUint16(BACKUP_MAGIC.length, BACKUP_FORMAT_VERSION);
  view.setUint32(BACKUP_MAGIC.length + 2, map.length);
  out.set(map, PREFIX_LENGTH);
  return out;
}

function parseKeyslot(value: CborValue, index: number): RecoveryKeyslot | PasswordKeyslot {
  if (!(value instanceof Map)) throw malformed();
  const t = value.get('t');
  if (index === 0 && t === RECOVERY && hasExactly(value, ['t', 'c'])) {
    return { type: 'recovery', sealed: value.get('c') as Uint8Array };
  }
  if (index === 1 && t === PASSWORD && hasExactly(value, ['t', 'salt', 'ops', 'mem', 'n', 'c'])) {
    return {
      type: 'password',
      salt: value.get('salt') as Uint8Array,
      opslimit: value.get('ops') as number,
      memlimit: value.get('mem') as number,
      wrap: { n: value.get('n') as Uint8Array, c: value.get('c') as Uint8Array },
    };
  }
  throw malformed();
}

/** `length` bytes from `offset`, or `malformed` when the source gives fewer or more. */
async function readExactly(source: BackupSource, offset: number, length: number) {
  const bytes = await source.read(offset, length);
  if (bytes.length !== length) throw malformed();
  return bytes;
}

/**
 * Reads a file's header, checked against §2, §3 and §7; the stream after it is left in the source
 * for `openBackup`. Nothing here is authenticated yet. Throws `BackupRejectedError`.
 */
export async function parseBackup(file: Uint8Array | BackupSource): Promise<ParsedBackup> {
  const source = file instanceof Uint8Array ? bytesSource(file) : file;
  const magic = BACKUP_MAGIC.length;
  const prefix = await readExactly(source, 0, Math.min(source.size, PREFIX_LENGTH));
  if (prefix.length < magic || BACKUP_MAGIC.some((b, i) => prefix[i] !== b)) {
    throw new BackupRejectedError('not-a-backup');
  }
  if (prefix.length < PREFIX_LENGTH) throw malformed();
  const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
  const version = view.getUint16(magic);
  if (version === 0) throw new BackupRejectedError('not-a-backup');
  if (version > BACKUP_FORMAT_VERSION) throw new BackupRejectedError('newer-version');
  const length = view.getUint32(magic + 2);
  // A header past the end of the file is a short read: `malformed` too.
  if (length < 1 || length > MAX_HEADER_LENGTH) throw malformed();
  const headerBytes = new Uint8Array(PREFIX_LENGTH + length);
  headerBytes.set(prefix);
  headerBytes.set(await readExactly(source, PREFIX_LENGTH, length), PREFIX_LENGTH);
  let map: CborValue;
  try {
    map = decodeCbor(headerBytes.subarray(PREFIX_LENGTH));
  } catch {
    throw malformed();
  }
  if (
    !(map instanceof Map) ||
    !hasExactly(map, ['keyslots', 'phraseCreatedAt', 'phraseId', 'stream'])
  ) {
    throw malformed();
  }
  const slots = map.get('keyslots');
  if (!Array.isArray(slots) || slots.length < 1 || slots.length > 2) throw malformed();
  const header = {
    phraseId: map.get('phraseId'),
    phraseCreatedAt: map.get('phraseCreatedAt'),
    keyslots: slots.map(parseKeyslot),
    stream: map.get('stream'),
  } as unknown as BackupHeader;
  checkHeader(header);
  return {
    version: version as 1 | 2,
    header: {
      phraseId: header.phraseId.slice(),
      phraseCreatedAt: header.phraseCreatedAt,
      keyslots: header.keyslots.map(copyKeyslot) as unknown as Keyslots,
      stream: header.stream.slice(),
    },
    headerBytes,
    source,
  };
}

function copyKeyslot(slot: RecoveryKeyslot | PasswordKeyslot): RecoveryKeyslot | PasswordKeyslot {
  if (slot.type === 'recovery') return { type: 'recovery', sealed: slot.sealed.slice() };
  return {
    ...slot,
    salt: slot.salt.slice(),
    wrap: { n: slot.wrap.n.slice(), c: slot.wrap.c.slice() },
  };
}

/**
 * Writes a version-2 file as the parts of a `Blob` (§1, §5, §6, D278): the header with a new stream
 * header, then each encrypted chunk as it closes. The keyslots are built by the caller; every
 * record is an envelope as stored, and each blob is read only when its turn comes, so the file is
 * never one buffer and at most one blob is held.
 */
export async function sealBackup(
  fileKey: SymmetricKey,
  header: Omit<BackupHeader, 'stream'>,
  meta: BackupMeta & { readonly masterKey: SymmetricKey },
  records: readonly Uint8Array[],
  blobs: readonly (() => Promise<Uint8Array>)[],
): Promise<Uint8Array[]> {
  const writer = BackupStreamWriter.create(fileKey);
  const headerBytes = encodeHeader({ ...header, stream: writer.header });
  const parts = [headerBytes];
  try {
    parts.push(
      ...writer.begin(headerBytes, {
        ...meta,
        recordCount: records.length,
        blobCount: blobs.length,
      }),
    );
    for (const record of records) parts.push(...writer.add(record));
    for (const read of blobs) parts.push(...writer.add(await read()));
    parts.push(...writer.end());
    return parts;
  } catch (error) {
    writer.wipe();
    if (error instanceof EncodingError) throw malformed();
    throw error;
  }
}

/**
 * Opens the stream of a parsed file with its file key, in the two passes of §6 and §8 steps 4
 * and 5; the first chunk authenticates the header. A stream that does not authenticate in full,
 * or a file that changed between the passes, is `corrupt`; an authenticated payload of the wrong
 * shape is `malformed`. The records are returned unverified (crypto-spec.md §9.5 runs next, §8);
 * the Master Key goes to `keyring` only once both passes agree.
 */
export async function openBackup(
  keyring: Keyring,
  fileKey: SymmetricKey,
  parsed: ParsedBackup,
): Promise<OpenedBackup> {
  const { version, header, headerBytes, source } = parsed;
  try {
    const scan = await scanBackupStream(fileKey, version, header.stream, headerBytes, source);
    const read = await readBackupStream(keyring, fileKey, scan, header.stream, headerBytes, source);
    return {
      vaultId: read.vaultId,
      exportedAt: read.exportedAt,
      masterKey: read.masterKey,
      records: read.records,
      blobIds: scan.blobIds,
      blobs: {
        next: () => read.blobs.next().catch(rejected),
      },
    };
  } catch (error) {
    return rejected(error);
  }
}

function rejected(error: unknown): never {
  if (error instanceof DecryptionError) throw new BackupRejectedError('corrupt');
  if (error instanceof EncodingError) throw malformed();
  throw error;
}
