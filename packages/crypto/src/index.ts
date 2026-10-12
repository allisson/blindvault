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
