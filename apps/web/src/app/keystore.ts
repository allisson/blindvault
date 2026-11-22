// The Keystore KEK's calls to the Android shell (android.md §5, D290, D292). This file only names the
// calls and their answers: the secret and the KEK are in `@blindvault/crypto`
// (`generateKeystoreSecret`, `deriveKeystoreKek`), and the Master Key never reaches the port.

/** Whether a strong biometric is enrolled and, when the key exists, whether StrongBox holds it. */
export interface KeystoreStatus {
  readonly available: boolean;
  readonly strongBox?: boolean;
}

/** The Keystore secret as the Android Keystore encrypted it. */
export interface KeystoreSealed {
  readonly iv: Uint8Array;
  readonly sealed: Uint8Array;
  readonly strongBox: boolean;
}

/** Every call names the key by the Local Config it belongs to (D292). */
export interface KeystorePort {
  status(localConfigId: Uint8Array): Promise<KeystoreStatus>;
  /** Creates the key, shows the BiometricPrompt and encrypts `secret`. */
  seal(localConfigId: Uint8Array, secret: Uint8Array): Promise<KeystoreSealed>;
  /** Shows the BiometricPrompt and answers the secret. */
  open(localConfigId: Uint8Array, iv: Uint8Array, sealed: Uint8Array): Promise<Uint8Array>;
  delete(localConfigId: Uint8Array): Promise<void>;
}

/** The user closed the BiometricPrompt. */
export class KeystoreCancelledError extends Error {
  override name = 'KeystoreCancelledError';
}

/** A new biometric was enrolled: the key is gone for good (`KeyPermanentlyInvalidatedException`). */
export class KeystoreInvalidatedError extends Error {
  override name = 'KeystoreInvalidatedError';
}

/** No strong biometric is enrolled on the device. */
export class KeystoreUnavailableError extends Error {
  override name = 'KeystoreUnavailableError';
}
