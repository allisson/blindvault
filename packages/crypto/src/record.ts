// Record format v1: envelope (crypto-spec.md §9.2), content sealing (§9.3), caps (§9.4) and the
// verification on receipt (§9.5, CRYPTO-INV-012, CRYPTO-INV-016, CRYPTO-INV-018).

import { type Sealed, NONCE_LENGTH, TAG_LENGTH, open, seal, unwrapKey, wrapKey } from './aead';
import { type CborMap, type CborValue, decodeCbor, encodeCbor } from './cbor';
import { CryptoError, DecryptionError, EncodingError } from './errors';
import { deviceId, recoveryEnvelopeRecordId, vaultKeyRecordId, versionId } from './ids';
import { KEY_LENGTH, Keyring, type SymmetricKey, generateKey } from './keys';
import { type RecordHeader, recordAad } from './layout';
import { PAD_BLOCK, pad, unpad } from './pad';
import { ID_LENGTH } from './sodium';

export const RECORD_FORMAT_VERSION = 1;

export const RecordType = {
  item: 1,
  folder: 2,
  itemVersion: 3,
  vaultKey: 4,
  recoveryEnvelope: 5,
  device: 6,
} as const;

export type RecordType = (typeof RecordType)[keyof typeof RecordType];

/** Largest plaintext content before padding (D129). */
export const RECORD_CAP = 1_048_576;
/** Largest valid `ct.c`: the record cap, a full padding block and the tag. */
export const MAX_CIPHERTEXT_LENGTH = RECORD_CAP + PAD_BLOCK + TAG_LENGTH;
/** Largest item content, without `trashOperationId` (D139, crypto-spec.md §9.4). */
export const ITEM_CAP = RECORD_CAP - 66;
/** Largest valid envelope: a Recovery Envelope at every maximum (`records.maxEnvelopeLength`). */
export const MAX_ENVELOPE_LENGTH = 1_049_130;

const U32_MAX = 0xffffffff;
const WRAP_LENGTH = KEY_LENGTH + TAG_LENGTH;
const HEADER_KEYS = ['v', 't', 'id', 'e', 'hlc', 'del'] as const;

type Part = 'wk' | 'ct' | 'mk';

/** The envelope keys besides the header, per record type (crypto-spec.md §9.1). */
const PARTS: Readonly<Record<RecordType, readonly Part[]>> = {
  [RecordType.item]: ['wk', 'ct'],
  [RecordType.folder]: ['wk', 'ct'],
  [RecordType.itemVersion]: ['wk', 'ct'],
  [RecordType.vaultKey]: ['ct'],
  [RecordType.recoveryEnvelope]: ['wk', 'ct', 'mk'],
  [RecordType.device]: ['wk', 'ct'],
};

/** Record types never accepted with `deleted = true` (D42, D56, CRYPTO-INV-016). */
const NEVER_DELETED: ReadonlySet<number> = new Set([
  RecordType.itemVersion,
  RecordType.vaultKey,
  RecordType.recoveryEnvelope,
  RecordType.device,
]);

function isRecordType(value: number): value is RecordType {
  return Object.hasOwn(PARTS, value);
}

/** A decoded envelope: the header and its sealed parts. */
export interface Envelope {
  readonly header: RecordHeader;
  readonly ct: Sealed;
  readonly wk?: Sealed;
  readonly mk?: Sealed;
}

declare const envelopeBrand: unique symbol;

/**
 * Envelope bytes as `encodeEnvelope` wrote them: a sealed record, never plaintext. Storage accepts
 * a record only as this type (D82); nothing else produces it.
 */
export type RecordEnvelope = Uint8Array & { readonly [envelopeBrand]: true };

/** A sealed record with its storage identity (`recordType`, `recordId`, D158). */
export interface EncryptedRecord {
  readonly recordType: RecordType;
  readonly recordId: Uint8Array;
  readonly envelope: RecordEnvelope;
}

/** The step of crypto-spec.md §9.5 a record failed. */
export type VerificationStep = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

/** A record that fails verification on receipt; it is never merged or persisted. */
export class RecordRejectedError extends CryptoError {
  override name = 'RecordRejectedError';
  readonly step: VerificationStep;

  constructor(step: VerificationStep, reason: string) {
    super(`record rejected at step ${String(step)}: ${reason}`);
    this.step = step;
  }
}

function reject(step: VerificationStep, reason: string): never {
  throw new RecordRejectedError(step, reason);
}

// --- envelope encoding ---------------------------------------------------------------------------

function sealedMap(sealed: Sealed): CborMap {
  return new Map<CborValue, CborValue>([
    ['n', sealed.n],
    ['c', sealed.c],
  ]);
}

/** Encodes an envelope as the deterministic CBOR map of crypto-spec.md §9.2. */
export function encodeEnvelope(envelope: Envelope): RecordEnvelope {
  const { header } = envelope;
  if (!isRecordType(header.recordType)) throw new EncodingError('unknown record type');
  const map: CborMap = new Map<CborValue, CborValue>([
    ['v', header.recordFormatVersion],
    ['t', header.recordType],
    ['id', header.recordId],
    ['e', header.keyEpoch],
    ['hlc', [header.hlc.physicalMs, header.hlc.counter, header.hlc.deviceId]],
    ['del', header.deleted],
  ]);
  for (const part of ['wk', 'ct', 'mk'] as const) {
    const sealed = envelope[part];
    const expected = PARTS[header.recordType].includes(part);
    if ((sealed !== undefined) !== expected) throw new EncodingError(`envelope part ${part}`);
    if (sealed) map.set(part, sealedMap(sealed));
  }
  return encodeCbor(map) as RecordEnvelope;
}

// --- verification steps 1 to 5 -------------------------------------------------------------------

function isUint(value: CborValue | undefined, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function isBytes(value: CborValue | undefined, length?: number): value is Uint8Array {
  return value instanceof Uint8Array && (length === undefined || value.length === length);
}

function parseSealed(value: CborValue | undefined, part: Part): Sealed {
  if (!(value instanceof Map) || value.size !== 2) reject(3, `${part} shape`);
  const n = value.get('n');
  const c = value.get('c');
  if (!isBytes(n, NONCE_LENGTH) || !isBytes(c)) reject(3, `${part} shape`);
  if (part !== 'ct' && c.length !== WRAP_LENGTH) reject(3, `${part} length`);
  return { n, c };
}

/**
 * Steps 1 to 5 of crypto-spec.md §9.5: size, strict encoding, structure, deletion state and
 * ciphertext length. Nothing is decrypted.
 */
export function decodeEnvelope(bytes: Uint8Array): Envelope {
  // Step 1: size, before decoding.
  if (bytes.length > MAX_ENVELOPE_LENGTH) reject(1, 'envelope too long');

  // Step 2: strict CBOR and the re-encode check.
  let map: CborValue;
  try {
    map = decodeCbor(bytes);
  } catch {
    reject(2, 'encoding');
  }

  // Step 3: structure.
  if (!(map instanceof Map) || [...map.keys()].some((k) => typeof k !== 'string')) {
    reject(3, 'not a text-keyed map');
  }
  const v = map.get('v');
  const t = map.get('t');
  if (v !== RECORD_FORMAT_VERSION || typeof t !== 'number' || !isRecordType(t)) {
    reject(3, 'unknown version or type');
  }
  const parts = PARTS[t];
  const keys = new Set<CborValue>([...HEADER_KEYS, ...parts]);
  if (map.size !== keys.size || [...map.keys()].some((k) => !keys.has(k))) {
    reject(3, 'envelope keys');
  }
  const recordId = map.get('id');
  if (!isBytes(recordId, ID_LENGTH)) reject(3, 'id');
  const e = map.get('e');
  if (!isUint(e, U32_MAX) || e < 1) reject(3, 'keyEpoch');
  const hlc = map.get('hlc');
  if (
    !Array.isArray(hlc) ||
    hlc.length !== 3 ||
    !isUint(hlc[0], Number.MAX_SAFE_INTEGER) ||
    !isUint(hlc[1], U32_MAX) ||
    !isBytes(hlc[2], ID_LENGTH)
  ) {
    reject(3, 'hlc');
  }
  const deleted = map.get('del');
  if (typeof deleted !== 'boolean') reject(3, 'del');
  const sealed: Partial<Record<Part, Sealed>> = {};
  for (const part of parts) sealed[part] = parseSealed(map.get(part), part);
  const ct = sealed.ct;
  if (!ct) reject(3, 'ct shape');

  // Step 4: deletion state.
  if (deleted && NEVER_DELETED.has(t)) reject(4, 'type is never deleted');

  // Step 5: ciphertext length, before any decryption.
  const length = ct.c.length;
  if (t === RecordType.vaultKey) {
    if (length !== WRAP_LENGTH) reject(5, 'Vault Key ct length');
  } else if (
    length > MAX_CIPHERTEXT_LENGTH ||
    !(length === TAG_LENGTH || (length > TAG_LENGTH && (length - TAG_LENGTH) % PAD_BLOCK === 0))
  ) {
    reject(5, 'ct length');
  }

  const header: RecordHeader = {
    recordFormatVersion: v,
    recordType: t,
    recordId,
    keyEpoch: e,
    hlc: { physicalMs: hlc[0], counter: hlc[1], deviceId: hlc[2] },
    deleted,
  };
  return {
    header,
    ct,
    ...(sealed.wk ? { wk: sealed.wk } : {}),
    ...(sealed.mk ? { mk: sealed.mk } : {}),
  };
}

// --- verification steps 6 to 10 ------------------------------------------------------------------

/** The keys a device holds to verify records of its vault. */
export interface VerificationKeys {
  readonly vaultId: Uint8Array;
  /** The Vault Key of `keyEpoch`, or `undefined` when it is not held. */
  vaultKey(keyEpoch: number): SymmetricKey | undefined;
  readonly vaultKeyWrapKey: SymmetricKey;
  readonly versionIdKey: SymmetricKey;
}

export interface VerifiedRecord {
  readonly envelope: Envelope;
  /** The decoded content; `null` for a purged tombstone and for a Vault Key record. */
  readonly content: CborMap | null;
  /** Vault Key record only: the Vault Key it holds, added to the caller's keyring. */
  readonly vaultKey?: SymmetricKey;
}

function decodeContent(plaintext: Uint8Array): CborMap {
  let content: CborValue;
  try {
    content = decodeCbor(unpad(plaintext));
  } catch {
    reject(8, 'padding or content encoding');
  }
  if (!(content instanceof Map) || [...content.keys()].some((k) => typeof k !== 'string')) {
    reject(8, 'content is not a text-keyed map');
  }
  return content;
}

/** The encoded length of an item map without `trashOperationId`, which the item cap counts. */
export function itemContentLength(item: CborMap): number {
  const counted = new Map(item);
  counted.delete('trashOperationId');
  return encodeCbor(counted).length;
}

function itemOf(header: RecordHeader, content: CborMap): CborMap | undefined {
  if (header.recordType === RecordType.item) return content;
  if (header.recordType === RecordType.itemVersion) {
    const item = content.get('item');
    if (!(item instanceof Map)) reject(9, 'Item Version without an item map');
    return item;
  }
  return undefined;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

type IdKeys = Pick<VerificationKeys, 'vaultId' | 'versionIdKey'>;

function expectedRecordId(
  header: RecordHeader,
  content: CborMap | null,
  keys: IdKeys,
): Uint8Array | undefined {
  switch (header.recordType) {
    case RecordType.recoveryEnvelope:
      return recoveryEnvelopeRecordId(keys.vaultId);
    case RecordType.itemVersion: {
      const itemId = content?.get('itemId');
      if (!isBytes(itemId, ID_LENGTH)) reject(10, 'Item Version itemId');
      return versionId(keys.versionIdKey, itemId, header.hlc);
    }
    case RecordType.device: {
      const publicKey = content?.get('publicKey');
      if (!isBytes(publicKey, KEY_LENGTH)) reject(10, 'Device publicKey');
      return deviceId(publicKey);
    }
    default:
      return undefined;
  }
}

/**
 * Verifies a received or restored record, crypto-spec.md §9.5 steps 1 to 10, in order. Any
 * failure throws `RecordRejectedError` with its step. A Recovery Envelope's `mk` is not opened:
 * only the Recovery Phrase opens it.
 */
export function verifyRecord(
  keyring: Keyring,
  bytes: Uint8Array,
  keys: VerificationKeys,
): VerifiedRecord {
  const envelope = decodeEnvelope(bytes);
  const { header } = envelope;

  // Step 6: AAD from the header and the local vaultId.
  const aad = recordAad(header, keys.vaultId);

  // Step 7: authentication.
  if (header.recordType === RecordType.vaultKey) {
    let vaultKey: SymmetricKey;
    try {
      vaultKey = unwrapKey(keyring, keys.vaultKeyWrapKey, aad, envelope.ct);
    } catch (error) {
      if (error instanceof DecryptionError) reject(7, 'authentication');
      throw error;
    }
    try {
      const expected = vaultKeyRecordId(header.keyEpoch);
      if (!sameBytes(header.recordId, expected)) reject(10, 'Vault Key recordId');
    } catch (error) {
      keyring.release(vaultKey);
      throw error;
    }
    return { envelope, content: null, vaultKey };
  }
  const vaultKey = keys.vaultKey(header.keyEpoch);
  if (!vaultKey) reject(7, 'Vault Key of the epoch is not held');
  const wk = envelope.wk;
  if (!wk) reject(3, 'wk shape');
  const recordKeys = new Keyring();
  let plaintext: Uint8Array;
  try {
    const recordKey = unwrapKey(recordKeys, vaultKey, aad, wk);
    plaintext = open(recordKey, aad, envelope.ct);
  } catch (error) {
    if (error instanceof DecryptionError) reject(7, 'authentication');
    throw error;
  } finally {
    recordKeys.wipeAll();
  }

  // Step 8: plaintext.
  let content: CborMap | null = null;
  if (plaintext.length === 0) {
    if (!header.deleted) reject(8, 'empty content in a live record');
  } else {
    content = decodeContent(plaintext);
    if (header.recordType === RecordType.recoveryEnvelope) {
      if (
        !isBytes(content.get('keyslotPublicKey'), KEY_LENGTH) ||
        !isBytes(content.get('phraseId'), ID_LENGTH) ||
        !isUint(content.get('phraseCreatedAt'), Number.MAX_SAFE_INTEGER)
      ) {
        reject(8, 'Recovery Envelope metadata');
      }
    }
  }

  // Step 9: item cap.
  if (content) {
    const item = itemOf(header, content);
    if (item && itemContentLength(item) > ITEM_CAP) reject(9, 'item cap');
  }

  // Step 10: derived recordId. A purged tombstone is an Item or Folder, whose IDs are random.
  if (content) {
    const expected = expectedRecordId(header, content, keys);
    if (expected && !sameBytes(header.recordId, expected)) reject(10, 'derived recordId');
  }
  return { envelope, content };
}

// --- writing -------------------------------------------------------------------------------------

function checkWriteHeader(header: RecordHeader, allowed: readonly RecordType[]): void {
  if (header.recordFormatVersion !== RECORD_FORMAT_VERSION) {
    throw new EncodingError('unsupported recordFormatVersion');
  }
  if (!allowed.some((t) => t === header.recordType)) {
    throw new EncodingError('record type not written by this function');
  }
  if (header.deleted && NEVER_DELETED.has(header.recordType)) {
    throw new EncodingError('record type is never deleted');
  }
}

/**
 * Seals an Item, Folder, Item Version or Device record under a new random record key (D18) and
 * returns its envelope. Refuses content above the record cap, an item above the item cap, and a
 * `recordId` that does not match its derivation.
 */
export function sealRecord(
  header: RecordHeader,
  keys: IdKeys,
  vaultKey: SymmetricKey,
  content: CborMap,
): RecordEnvelope {
  checkWriteHeader(header, [
    RecordType.item,
    RecordType.folder,
    RecordType.itemVersion,
    RecordType.device,
  ]);
  const encoded = encodeCbor(content);
  if (encoded.length > RECORD_CAP) throw new EncodingError('content above the record cap');
  try {
    const item = itemOf(header, content);
    if (item && itemContentLength(item) > ITEM_CAP) {
      throw new EncodingError('item above the item cap');
    }
    const expected = expectedRecordId(header, content, keys);
    if (expected && !sameBytes(header.recordId, expected)) {
      throw new EncodingError('recordId does not match its derivation');
    }
  } catch (error) {
    if (error instanceof RecordRejectedError) throw new EncodingError(error.message);
    throw error;
  }
  return sealParts(header, keys.vaultId, vaultKey, pad(encoded));
}

/** Seals a purged tombstone: same header, empty content, no padding (D27). */
export function sealPurgedTombstone(
  header: RecordHeader,
  vaultId: Uint8Array,
  vaultKey: SymmetricKey,
): RecordEnvelope {
  checkWriteHeader(header, [RecordType.item, RecordType.folder]);
  if (!header.deleted) throw new EncodingError('a purged tombstone has deleted = true');
  return sealParts(header, vaultId, vaultKey, new Uint8Array(0));
}

function sealParts(
  header: RecordHeader,
  vaultId: Uint8Array,
  vaultKey: SymmetricKey,
  plaintext: Uint8Array,
): RecordEnvelope {
  const aad = recordAad(header, vaultId);
  const recordKeys = new Keyring();
  try {
    const recordKey = generateKey(recordKeys);
    return encodeEnvelope({
      header,
      wk: wrapKey(vaultKey, aad, recordKey),
      ct: seal(recordKey, aad, plaintext),
    });
  } finally {
    recordKeys.wipeAll();
  }
}

/** Seals the Vault Key record of `header.keyEpoch` under `K_vaultKeyWrap` (crypto-spec.md §10). */
export function sealVaultKeyRecord(
  header: RecordHeader,
  vaultId: Uint8Array,
  vaultKeyWrapKey: SymmetricKey,
  vaultKey: SymmetricKey,
): RecordEnvelope {
  checkWriteHeader(header, [RecordType.vaultKey]);
  if (!sameBytes(header.recordId, vaultKeyRecordId(header.keyEpoch))) {
    throw new EncodingError('recordId does not match its derivation');
  }
  return encodeEnvelope({
    header,
    ct: wrapKey(vaultKeyWrapKey, recordAad(header, vaultId), vaultKey),
  });
}

/**
 * Seals the Recovery Envelope (crypto-spec.md §11): `mk`, the Master Key under `K_envelope`, and
 * the metadata under a record key wrapped by the Vault Key, so any unlocked device reads the
 * keyslot public key without the phrase (D16, D24). The metadata MUST hold `keyslotPublicKey`,
 * `phraseId` and `phraseCreatedAt`; unknown keys are kept (D98).
 */
export function sealRecoveryEnvelope(
  header: RecordHeader,
  vaultId: Uint8Array,
  vaultKey: SymmetricKey,
  envelopeKey: SymmetricKey,
  masterKey: SymmetricKey,
  metadata: CborMap,
): RecordEnvelope {
  checkWriteHeader(header, [RecordType.recoveryEnvelope]);
  if (!sameBytes(header.recordId, recoveryEnvelopeRecordId(vaultId))) {
    throw new EncodingError('recordId does not match its derivation');
  }
  if (
    !isBytes(metadata.get('keyslotPublicKey'), KEY_LENGTH) ||
    !isBytes(metadata.get('phraseId'), ID_LENGTH) ||
    !isUint(metadata.get('phraseCreatedAt'), Number.MAX_SAFE_INTEGER)
  ) {
    throw new EncodingError('invalid Recovery Envelope metadata');
  }
  const encoded = encodeCbor(metadata);
  if (encoded.length > RECORD_CAP) throw new EncodingError('content above the record cap');
  const aad = recordAad(header, vaultId);
  const recordKeys = new Keyring();
  try {
    const recordKey = generateKey(recordKeys);
    return encodeEnvelope({
      header,
      wk: wrapKey(vaultKey, aad, recordKey),
      ct: seal(recordKey, aad, pad(encoded)),
      mk: wrapKey(envelopeKey, aad, masterKey),
    });
  } finally {
    recordKeys.wipeAll();
  }
}

/**
 * Opens a Recovery Envelope's `mk` with `K_envelope` from a typed phrase (§5.4): the Master Key, in
 * a new handle of `keyring`. Anything but a Recovery Envelope whose `mk` opens under its AAD is the
 * same `DecryptionError`. The envelope's other parts are verified on receipt, not here.
 */
export function openRecoveryEnvelope(
  keyring: Keyring,
  bytes: Uint8Array,
  vaultId: Uint8Array,
  envelopeKey: SymmetricKey,
): SymmetricKey {
  let envelope: Envelope;
  try {
    envelope = decodeEnvelope(bytes);
  } catch {
    throw new DecryptionError();
  }
  const { header, mk } = envelope;
  if (header.recordType !== RecordType.recoveryEnvelope || !mk) throw new DecryptionError();
  return unwrapKey(keyring, envelopeKey, recordAad(header, vaultId), mk);
}
