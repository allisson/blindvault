// @blindvault/crypto: Cryptographic primitives, key hierarchy, AEAD and AAD serialization.
// Only this file is the package's API: functions marked @internal stay inside the package.

export {
  CryptoError,
  CryptoNotReadyError,
  DecryptionError,
  EncodingError,
  GeneratorRejectedError,
  KdfParamsRejectedError,
  KdfWorkerError,
  KeyWipedError,
  PasswordRejectedError,
  PhraseRejectedError,
  TotpRejectedError,
  UserVerificationError,
} from './errors';
export { ID_LENGTH, initCrypto, randomBytes, randomId } from './sodium';
export { KEY_LENGTH, Keyring, PrivateKey, SymmetricKey, generateKey } from './keys';
export { type MasterSubkeys, deriveMasterSubkeys } from './kdf';
export {
  ACCEPTED_KDF_RANGE,
  type KdfParams,
  MEMLIMIT,
  SALT_LENGTH,
  checkKdfParams,
  generateSalt,
  normalizePassword,
} from './password';
export {
  type KdfPort,
  type KdfRequest,
  type KdfResponse,
  calibrateDeviceKek,
  deriveDeviceKek,
} from './kdf-worker';
export {
  PHRASE_WORDS,
  type RecoveryKeys,
  type RecoveryPhrase,
  deriveRecoveryKeys,
  generateRecoveryPhrase,
  parseRecoveryPhrase,
} from './recovery';
export { type DeviceIdentity, generateDeviceIdentity, loadDeviceIdentity } from './identity';
export {
  PRF_INPUT_LENGTH,
  type PrfAssertion,
  derivePrfKek,
  generatePrfInput,
  isBackupEligible,
} from './prf';
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
export {
  type TotpAlgorithm,
  type TotpValue,
  checkTotpValue,
  parseOtpauthUri,
  parseTotpSecret,
  totpCode,
  totpSecondsRemaining,
} from './totp';
export {
  CharacterSet,
  type CharacterSetName,
  DEFAULT_SETS,
  GENERATOR_LIMITS,
  type Generated,
  WORD_SEPARATOR,
  generatePassphrase,
  generatePassword,
  passphraseEntropyBits,
  passwordEntropyBits,
} from './generator';
