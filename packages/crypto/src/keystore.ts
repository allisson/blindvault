// Keystore KEK (crypto-spec.md §5.3, D271, D290). The Android shell keeps the Keystore secret behind
// a strong-biometric prompt; this module makes the secret and derives the KEK from it. The secret
// never reaches storage in cleartext, and the Master Key never reaches the shell (CRYPTO-INV-028).

import { EncodingError } from './errors';
import { KdfContext, deriveSubkey } from './kdf';
import { Keyring, type SymmetricKey } from './keys';
import { lib, randomBytes } from './sodium';

export const KEYSTORE_SECRET_LENGTH = 32;

/** A random Keystore secret, sent to the shell once at setup and wiped by `deriveKeystoreKek`. */
export function generateKeystoreSecret(): Uint8Array {
  return randomBytes(KEYSTORE_SECRET_LENGTH);
}

/**
 * The Keystore KEK from the secret the shell released. A secret that is not 32 bytes is refused
 * before any derivation. The secret is wiped in every case.
 */
export function deriveKeystoreKek(keyring: Keyring, secret: Uint8Array): SymmetricKey {
  const scratch = new Keyring();
  try {
    if (secret.length !== KEYSTORE_SECRET_LENGTH) {
      throw new EncodingError('Keystore secret is 32 bytes');
    }
    const parent = scratch.adopt(secret.slice());
    return deriveSubkey(keyring, parent, KdfContext.keystore, 1);
  } finally {
    lib().memzero(secret);
    scratch.wipeAll();
  }
}
