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

/** A password fails normalization (crypto-spec.md §6): empty, whitespace only or a control character. */
export class PasswordRejectedError extends CryptoError {
  override name = 'PasswordRejectedError';
  constructor(readonly reason: 'empty' | 'control-character') {
    super(`password rejected: ${reason}`);
  }
}

/** Stored Argon2id parameters outside the accepted range, rejected before deriving (§6). */
export class KdfParamsRejectedError extends CryptoError {
  override name = 'KdfParamsRejectedError';
  constructor() {
    super('Argon2id parameters outside the accepted range');
  }
}

/** The Argon2id worker failed or answered something other than a 32-byte key. */
export class KdfWorkerError extends CryptoError {
  override name = 'KdfWorkerError';
  constructor() {
    super('Argon2id worker failed');
  }
}

/** A typed Recovery Phrase is not 24 words of the English list with a valid checksum (§5.1). */
export class PhraseRejectedError extends CryptoError {
  override name = 'PhraseRejectedError';
  constructor(readonly reason: 'word-count' | 'unknown-word' | 'checksum') {
    super(`recovery phrase rejected: ${reason}`);
  }
}

/** A WebAuthn assertion without user verification, or malformed, refused for the PRF KEK (D75). */
export class UserVerificationError extends CryptoError {
  override name = 'UserVerificationError';
  constructor() {
    super('assertion without user verification');
  }
}
