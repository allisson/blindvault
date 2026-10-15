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
export {
  KEY_LENGTH,
  Keyring,
  PrivateKey,
  SymmetricKey,
  exportTransferKey,
  generateKey,
  importTransferKey,
  sameKey,
} from './keys';
export { type MasterSubkeys, deriveMasterSubkeys, isMasterKeyOf } from './kdf';
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
  derivePasswordKek,
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
  HANDSHAKE_HASH_LENGTH,
  NOISE_MAX_HANDSHAKE_PAYLOAD_LENGTH,
  NOISE_MAX_MESSAGE_LENGTH,
  NOISE_MAX_PLAINTEXT_LENGTH,
  NOISE_TAG_LENGTH,
  NoiseError,
  type NoiseHandshake,
  type NoiseResult,
  type NoiseTransport,
  startNoiseXX,
} from './noise';
export {
  DTLS_FINGERPRINT_LENGTH,
  PAIRING_COMMITMENT_LENGTH,
  PAIRING_NONCE_LENGTH,
  READMISSION_MAC_LENGTH,
  checkPairingCommitment,
  checkReadmissionMac,
  pairingCommitment,
  pairingNonce,
  pairingPrologue,
  pairingSas,
  readmissionMac,
} from './transcripts';
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
export { openLocalConfigPart, sealLocalConfigPart } from './local-config';
export { PASSWORD_KEYSLOT_AAD, SEALED_KEY_LENGTH, openSealedKey, sealKeyTo } from './keyslot';
export {
  type BackupMeta,
  BackupStreamWriter,
  CHUNK_LENGTH,
  MAX_META_LENGTH,
  type OpenedBackupPayload,
  STREAM_HEADER_LENGTH,
  openBackupStream,
} from './backup-stream';
export {
  PUBLIC_KEY_LENGTH,
  deviceId,
  recoveryEnvelopeRecordId,
  vaultKeyRecordId,
  versionId,
} from './ids';
export {
  type BackupEnvelopeCheck,
  type EncryptedRecord,
  type Envelope,
  ITEM_CAP,
  MAX_CIPHERTEXT_LENGTH,
  MAX_ENVELOPE_LENGTH,
  NewerRecordError,
  RECORD_CAP,
  RECORD_FORMAT_VERSION,
  type RecordEnvelope,
  RecordRejectedError,
  type RecoveryCheckResult,
  RecordType,
  type VerificationKeys,
  type VerificationStep,
  type VerifiedRecord,
  checkBackupRecoveryEnvelope,
  checkRecoveryEnvelope,
  decodeEnvelope,
  encodeEnvelope,
  itemContentLength,
  openRecoveryEnvelope,
  sealPurgedTombstone,
  sealRecord,
  sealRecoveryEnvelope,
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
