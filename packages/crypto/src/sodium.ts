import sodium from 'libsodium-wrappers-sumo';

import { CryptoNotReadyError, EncodingError } from './errors';

let ready = false;

/** Loads libsodium's WebAssembly. Every other function of this package requires it first. */
export async function initCrypto(): Promise<void> {
  await sodium.ready;
  ready = true;
}

/** The initialized libsodium module; throws until `initCrypto()` has resolved. */
export function lib(): typeof sodium {
  if (!ready) throw new CryptoNotReadyError();
  return sodium;
}

/** `length` bytes from libsodium's CSPRNG (`randombytes_buf`). */
export function randomBytes(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 1) {
    throw new EncodingError('random length must be a positive integer');
  }
  return lib().randombytes_buf(length);
}

export const ID_LENGTH = 16;

/** A random 16-byte identifier (`vaultId`, `localConfigId`, item and folder IDs, …). */
export function randomId(): Uint8Array {
  return randomBytes(ID_LENGTH);
}
