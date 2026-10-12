// `.bvault` keyslots (backup-format.md §3, D16, D36): the file key sealed to the recovery keyslot
// public key, and the AAD of the password keyslot's wrap. The file key's bytes stay here.

import { DecryptionError, EncodingError } from './errors';
import {
  KEY_LENGTH,
  type Keyring,
  type PrivateKey,
  type SymmetricKey,
  keyBytes,
  privateKeyBytes,
} from './keys';
import { label, layout } from './layout';
import { lib } from './sodium';

/** `crypto_box_seal` of a 32-byte key: ephemeral public key (32), key (32) and tag (16). */
export const SEALED_KEY_LENGTH = 80;

/** `layout("bv.bvault.v1.keyslot.password")`, the AAD of the password keyslot's wrap. */
export const PASSWORD_KEYSLOT_AAD = layout(label('bv.bvault.v1.keyslot.password'));

/** Seals `key` to an X25519 public key: anyone holding the public key can make a keyslot. */
export function sealKeyTo(publicKey: Uint8Array, key: SymmetricKey): Uint8Array {
  const bytes = keyBytes(key);
  if (publicKey.length !== KEY_LENGTH) throw new EncodingError('a public key is 32 bytes');
  return lib().crypto_box_seal(bytes, publicKey);
}

/**
 * Opens a sealed key into a new handle of `keyring`. Every failure, a wrong key pair, a changed
 * byte, a wrong length or a plaintext that is not 32 bytes, is the same `DecryptionError`.
 */
export function openSealedKey(
  keyring: Keyring,
  publicKey: Uint8Array,
  privateKey: PrivateKey,
  sealed: Uint8Array,
): SymmetricKey {
  const secret = privateKeyBytes(privateKey);
  if (publicKey.length !== KEY_LENGTH || sealed.length !== SEALED_KEY_LENGTH) {
    throw new DecryptionError();
  }
  let plaintext: Uint8Array;
  try {
    // An 80-byte box opens to exactly 32 bytes.
    plaintext = lib().crypto_box_seal_open(sealed, publicKey, secret);
  } catch {
    throw new DecryptionError();
  }
  return keyring.adopt(plaintext);
}
