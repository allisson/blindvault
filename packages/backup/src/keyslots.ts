// The two keyslots of a `.bvault` file (backup-format.md §3, §4, §8, D16, D36, D78): each wraps the
// file key, so either one reaches the payload.

import {
  DecryptionError,
  KdfParamsRejectedError,
  type KdfPort,
  Keyring,
  PASSWORD_KEYSLOT_AAD,
  type RecoveryKeys,
  type SymmetricKey,
  checkKdfParams,
  derivePasswordKek,
  generateSalt,
  openSealedKey,
  sealKeyTo,
  unwrapKey,
  wrapKey,
} from '@blindvault/crypto';

import { BackupRejectedError } from './errors';
import {
  type BackupHeader,
  EXPORT_KDF,
  type PasswordKeyslot,
  type RecoveryKeyslot,
} from './format';

/**
 * The recovery keyslot: the file key sealed to the recovery keyslot public key read from the
 * Recovery Envelope metadata, so an unlocked device makes it without the phrase (D16).
 */
export function createRecoveryKeyslot(
  fileKey: SymmetricKey,
  keyslotPublicKey: Uint8Array,
): RecoveryKeyslot {
  return { type: 'recovery', sealed: sealKeyTo(keyslotPublicKey, fileKey) };
}

/**
 * The password keyslot at the fixed export parameters, under a new salt (§3, §4). `password` is
 * already normalized and has passed the export strength check (D134, D155); it is wiped.
 */
export async function createPasswordKeyslot(
  keyring: Keyring,
  port: KdfPort,
  fileKey: SymmetricKey,
  password: Uint8Array,
): Promise<PasswordKeyslot> {
  const salt = generateSalt();
  // The KEK lives in a keyring of its own, wiped as soon as the wrap is made.
  const scratch = new Keyring();
  const kek = await derivePasswordKek(scratch, port, password, salt, EXPORT_KDF);
  try {
    return {
      type: 'password',
      salt,
      ...EXPORT_KDF,
      wrap: wrapKey(kek, PASSWORD_KEYSLOT_AAD, fileKey),
    };
  } finally {
    scratch.wipeAll();
  }
}

/**
 * Opens the recovery keyslot with the keys derived from the typed phrase. Another phrase and a
 * tampered keyslot are the same `wrong-secret`. The caller releases the keyslot private key.
 */
export function openRecoveryKeyslot(
  keyring: Keyring,
  header: BackupHeader,
  keys: RecoveryKeys,
): SymmetricKey {
  try {
    return openSealedKey(
      keyring,
      keys.keyslotPublicKey,
      keys.keyslotPrivateKey,
      header.keyslots[0].sealed,
    );
  } catch (error) {
    if (error instanceof DecryptionError) throw new BackupRejectedError('wrong-secret');
    throw error;
  }
}

/**
 * Opens the password keyslot with a normalized export password, which is wiped. Its parameters are
 * checked against the accepted range before Argon2id runs, since the header is not authenticated
 * yet (D78): outside it, the keyslot is `malformed`. A wrong password and a tampered wrap are the
 * same `wrong-secret`.
 */
export async function openPasswordKeyslot(
  keyring: Keyring,
  port: KdfPort,
  header: BackupHeader,
  password: Uint8Array,
): Promise<SymmetricKey> {
  const slot = header.keyslots[1];
  const params = slot && { opslimit: slot.opslimit, memlimit: slot.memlimit };
  try {
    if (!slot || !params) throw new BackupRejectedError('no-password-keyslot');
    checkKdfParams(params);
  } catch (error) {
    password.fill(0);
    port.terminate();
    if (error instanceof KdfParamsRejectedError) throw new BackupRejectedError('malformed');
    throw error;
  }
  const scratch = new Keyring();
  const kek = await derivePasswordKek(scratch, port, password, slot.salt, params);
  try {
    // A lock during the derivation wiped `keyring`: the file key is then refused, never kept.
    return unwrapKey(keyring, kek, PASSWORD_KEYSLOT_AAD, slot.wrap);
  } catch (error) {
    if (error instanceof DecryptionError) throw new BackupRejectedError('wrong-secret');
    throw error;
  } finally {
    scratch.wipeAll();
  }
}
