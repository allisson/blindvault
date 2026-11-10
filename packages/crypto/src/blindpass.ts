// Decryption of a BlindPass `.blindpass` export (blindpass-format.md §2, D125, D126): Argon2id at
// BlindPass's fixed parameters in the worker, then `crypto_secretbox_open_easy`, which serves this
// import only and never protects vault data (crypto-spec.md §2).

import { BlindPassRejectedError, DecryptionError } from './errors';
import { type KdfPort, deriveBlindPassKey } from './kdf-worker';
import { SALT_LENGTH } from './password';
import { lib } from './sodium';

function bytes(value: unknown, length?: number): Uint8Array {
  const sodium = lib();
  try {
    // libsodium throws on a value that is not a string, as on one not standard padded base64.
    const out = sodium.from_base64(value as string, sodium.base64_variants.ORIGINAL);
    if (
      length === undefined ? out.length >= sodium.crypto_secretbox_MACBYTES : out.length === length
    )
      return out;
  } catch {
    // Rejected below.
  }
  throw new BlindPassRejectedError('not-this-format');
}

/**
 * The plaintext export a `.blindpass` file holds, as the JSON text BlindPass writes to a `.json`
 * export, for `parseBlindPassExport`. `passphrase` is used as its UTF-8 bytes, unnormalized, as
 * BlindPass uses it. The file is checked before Argon2id runs; a wrong passphrase or a damaged file
 * is a `DecryptionError`, the two being indistinguishable. The worker is always terminated.
 */
export async function openBlindPassExport(
  port: KdfPort,
  file: string,
  passphrase: string,
): Promise<string> {
  let salt: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array;
  try {
    let data: unknown;
    try {
      data = JSON.parse(file);
    } catch {
      throw new BlindPassRejectedError('not-this-format');
    }
    if (typeof data !== 'object' || data === null) {
      throw new BlindPassRejectedError('not-this-format');
    }
    const o = data as Record<string, unknown>;
    if (o.type !== 'blindpass-export-encrypted')
      throw new BlindPassRejectedError('not-this-format');
    if (o.version !== 1) throw new BlindPassRejectedError('unsupported-version');
    salt = bytes(o.kekSalt, SALT_LENGTH);
    nonce = bytes(o.nonce, lib().crypto_secretbox_NONCEBYTES);
    ciphertext = bytes(o.ciphertext);
  } catch (error) {
    port.terminate();
    throw error;
  }
  const key = await deriveBlindPassKey(port, lib().from_string(passphrase), salt);
  let plaintext: Uint8Array;
  try {
    plaintext = lib().crypto_secretbox_open_easy(ciphertext, nonce, key);
  } catch {
    throw new DecryptionError();
  } finally {
    lib().memzero(key);
  }
  try {
    return lib().to_string(plaintext);
  } finally {
    lib().memzero(plaintext);
  }
}
