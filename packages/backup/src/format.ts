// The `.bvault` v1 file (backup-format.md, D3, D78, D95, D178): the cleartext header and its
// keyslots, around the stream and payload that `@blindvault/crypto` seals and opens.

import {
  type BackupMeta,
  BackupStreamWriter,
  type CborMap,
  type CborValue,
  DecryptionError,
  EncodingError,
  ID_LENGTH,
  KEY_LENGTH,
  type Keyring,
  NONCE_LENGTH,
  type OpenedBackupPayload,
  SALT_LENGTH,
  STREAM_HEADER_LENGTH,
  type Sealed,
  type SymmetricKey,
  TAG_LENGTH,
  decodeCbor,
  encodeCbor,
  openBackupStream,
} from '@blindvault/crypto';

import { BackupRejectedError } from './errors';

export const BACKUP_MAGIC = new Uint8Array([0x89, 0x42, 0x56, 0x41, 0x55, 0x4c, 0x54, 0x0a]);
export const BACKUP_FORMAT_VERSION = 1;
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
  /** Not authenticated until `openBackup` succeeds: show `phraseId` and its date as unverified. */
  readonly header: BackupHeader;
  /** The header bytes as read, the first chunk's additional data. */
  readonly headerBytes: Uint8Array;
  readonly body: Uint8Array;
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

/**
 * Splits a file into its header, checked against §2, §3 and §7, and the stream body. Nothing here
 * is authenticated yet. Throws `BackupRejectedError`.
 */
export function parseBackup(file: Uint8Array): ParsedBackup {
  const magic = BACKUP_MAGIC.length;
  if (file.length < magic || BACKUP_MAGIC.some((b, i) => file[i] !== b)) {
    throw new BackupRejectedError('not-a-backup');
  }
  if (file.length < PREFIX_LENGTH) throw malformed();
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const version = view.getUint16(magic);
  if (version === 0) throw new BackupRejectedError('not-a-backup');
  if (version > BACKUP_FORMAT_VERSION) throw new BackupRejectedError('newer-version');
  const length = view.getUint32(magic + 2);
  if (length < 1 || length > MAX_HEADER_LENGTH || PREFIX_LENGTH + length > file.length) {
    throw malformed();
  }
  let map: CborValue;
  try {
    map = decodeCbor(file.subarray(PREFIX_LENGTH, PREFIX_LENGTH + length));
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
    header: {
      phraseId: header.phraseId.slice(),
      phraseCreatedAt: header.phraseCreatedAt,
      keyslots: header.keyslots.map(copyKeyslot) as unknown as Keyslots,
      stream: header.stream.slice(),
    },
    headerBytes: file.slice(0, PREFIX_LENGTH + length),
    body: file.subarray(PREFIX_LENGTH + length),
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
 * Writes a whole file: the header with a new stream header, then the payload under `fileKey`
 * (§1, §5, §6). The keyslots are built by the caller; every record is an envelope as stored.
 */
export function sealBackup(
  fileKey: SymmetricKey,
  header: Omit<BackupHeader, 'stream'>,
  meta: BackupMeta & { readonly masterKey: SymmetricKey },
  records: readonly Uint8Array[],
): Uint8Array {
  const writer = BackupStreamWriter.create(fileKey);
  const headerBytes = encodeHeader({ ...header, stream: writer.header });
  let body: Uint8Array;
  try {
    body = writer.seal(headerBytes, meta, records);
  } catch (error) {
    if (error instanceof EncodingError) throw malformed();
    throw error;
  }
  const file = new Uint8Array(headerBytes.length + body.length);
  file.set(headerBytes);
  file.set(body, headerBytes.length);
  return file;
}

/**
 * Opens the stream of a parsed file with its file key, which authenticates the header. A stream
 * that does not authenticate in full is `corrupt`; an authenticated payload of the wrong shape is
 * `malformed`. The records are returned unverified (crypto-spec.md §9.5 runs next, §8).
 */
export function openBackup(
  keyring: Keyring,
  fileKey: SymmetricKey,
  parsed: ParsedBackup,
): OpenedBackupPayload {
  try {
    return openBackupStream(
      keyring,
      fileKey,
      parsed.header.stream,
      parsed.headerBytes,
      parsed.body,
    );
  } catch (error) {
    if (error instanceof DecryptionError) throw new BackupRejectedError('corrupt');
    if (error instanceof EncodingError) throw malformed();
    throw error;
  }
}
