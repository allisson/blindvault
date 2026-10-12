// @blindvault/crypto: Cryptographic primitives, key hierarchy, AEAD and AAD serialization.
// Only this file is the package's API: functions marked @internal stay inside the package.

export {
  CryptoError,
  CryptoNotReadyError,
  DecryptionError,
  EncodingError,
  KeyWipedError,
} from './errors';
export { ID_LENGTH, initCrypto, randomBytes, randomId } from './sodium';
export { KEY_LENGTH, Keyring, SymmetricKey, generateKey } from './keys';
export { type Hlc, LocalPurpose, type RecordHeader, localAad, recordAad } from './layout';
export { NONCE_LENGTH, type Sealed, TAG_LENGTH, open, seal, unwrapKey, wrapKey } from './aead';
export { type CborMap, type CborValue, decodeCbor, encodeCbor } from './cbor';
export { PAD_BLOCK, pad, unpad } from './pad';
export {
  PUBLIC_KEY_LENGTH,
  deviceId,
  recoveryEnvelopeRecordId,
  vaultKeyRecordId,
  versionId,
} from './ids';
export {
  type Envelope,
  ITEM_CAP,
  MAX_CIPHERTEXT_LENGTH,
  MAX_ENVELOPE_LENGTH,
  RECORD_CAP,
  RECORD_FORMAT_VERSION,
  RecordRejectedError,
  RecordType,
  type VerificationKeys,
  type VerificationStep,
  type VerifiedRecord,
  decodeEnvelope,
  encodeEnvelope,
  itemContentLength,
  sealPurgedTombstone,
  sealRecord,
  sealVaultKeyRecord,
  verifyRecord,
} from './record';
