// Errors carry fixed messages only: never a key, a plaintext or any other secret (CRYPTO-INV-005).

export class CryptoError extends Error {
  override name = 'CryptoError';
}

/** A crypto function was called before `initCrypto()` resolved. */
export class CryptoNotReadyError extends CryptoError {
  override name = 'CryptoNotReadyError';
  constructor() {
    super('libsodium is not initialized: await initCrypto() first');
  }
}

/** A key was used after its keyring was wiped, or a wiped keyring received a key. */
export class KeyWipedError extends CryptoError {
  override name = 'KeyWipedError';
  constructor() {
    super('key material was wiped');
  }
}

/** Any decryption failure: wrong key, wrong AAD, tampered ciphertext or tag, malformed input. */
export class DecryptionError extends CryptoError {
  override name = 'DecryptionError';
  constructor() {
    super('decryption failed');
  }
}

/** A value cannot be encoded: out of range, wrong length or not ASCII. */
export class EncodingError extends CryptoError {
  override name = 'EncodingError';
}
