// XChaCha20-Poly1305 with mandatory AAD (crypto-spec.md §7) and key wraps (D8).

import { DecryptionError, EncodingError } from './errors';
import { KEY_LENGTH, type Keyring, type SymmetricKey, adoptKey, keyBytes } from './keys';
import { lib, randomBytes } from './sodium';

export const NONCE_LENGTH = 24;
export const TAG_LENGTH = 16;

/** A sealed value: the nonce and the ciphertext followed by its 16-byte tag. */
export interface Sealed {
  readonly n: Uint8Array;
  readonly c: Uint8Array;
}

function checkAad(aad: Uint8Array): void {
  if (aad.length === 0) throw new EncodingError('AAD is mandatory');
}

/** Encrypts under a new random 24-byte nonce. */
export function seal(key: SymmetricKey, aad: Uint8Array, plaintext: Uint8Array): Sealed {
  return sealWithNonce(key, aad, plaintext, randomBytes(NONCE_LENGTH));
}

/**
 * @internal Encrypts under a given nonce, for the fixed-nonce test vectors only. Never exported
 * from the package: every nonce outside tests comes from `seal`.
 */
export function sealWithNonce(
  key: SymmetricKey,
  aad: Uint8Array,
  plaintext: Uint8Array,
  nonce: Uint8Array,
): Sealed {
  checkAad(aad);
  if (nonce.length !== NONCE_LENGTH) throw new EncodingError('a nonce is 24 bytes');
  const c = lib().crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    aad,
    null,
    nonce,
    keyBytes(key),
  );
  return { n: nonce.slice(), c };
}

/**
 * Decrypts and authenticates. Every failure, malformed input included, is the same
 * `DecryptionError`, and no partial plaintext is returned.
 */
export function open(key: SymmetricKey, aad: Uint8Array, sealed: Sealed): Uint8Array {
  checkAad(aad);
  const bytes = keyBytes(key);
  if (sealed.n.length !== NONCE_LENGTH || sealed.c.length < TAG_LENGTH) {
    throw new DecryptionError();
  }
  try {
    return lib().crypto_aead_xchacha20poly1305_ietf_decrypt(null, sealed.c, aad, sealed.n, bytes);
  } catch {
    throw new DecryptionError();
  }
}

/** Seals one key under another (record key under a Vault Key, Master Key under a KEK, …). */
export function wrapKey(wrappingKey: SymmetricKey, aad: Uint8Array, key: SymmetricKey): Sealed {
  return seal(wrappingKey, aad, keyBytes(key));
}

/** Opens a key wrap into a new handle of `keyring`; anything but 32 bytes of plaintext fails. */
export function unwrapKey(
  keyring: Keyring,
  wrappingKey: SymmetricKey,
  aad: Uint8Array,
  sealed: Sealed,
): SymmetricKey {
  const plaintext = open(wrappingKey, aad, sealed);
  if (plaintext.length !== KEY_LENGTH) {
    lib().memzero(plaintext);
    throw new DecryptionError();
  }
  return adoptKey(keyring, plaintext);
}
