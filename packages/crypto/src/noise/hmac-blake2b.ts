// hmac-blake2b 2.0.2, index.js (see LICENSE): HMAC (RFC 2104) over BLAKE2b-512.
// Deviations: libsodium-wrappers-sumo instead of sodium-universal, so `crypto_generichash_batch` is
// `generichashBatch` below (init, update per part, final); `Uint8Array` instead of `sodium_malloc`;
// `assert` from ./assert; `data` is always an array.

import { lib } from '../sodium';
import { assert } from './assert';

const HASHLEN = 64;
const BLOCKLEN = 128;
const scratch = new Uint8Array(BLOCKLEN * 3);
const HMACKey = scratch.subarray(BLOCKLEN * 0, BLOCKLEN * 1);
const OuterKeyPad = scratch.subarray(BLOCKLEN * 1, BLOCKLEN * 2);
const InnerKeyPad = scratch.subarray(BLOCKLEN * 2, BLOCKLEN * 3);

/** `crypto_generichash_batch`: the unkeyed BLAKE2b of the parts' concatenation, into `out`. */
export function generichashBatch(out: Uint8Array, data: readonly Uint8Array[]): void {
  const state = lib().crypto_generichash_init(null, out.byteLength);
  for (const part of data) lib().crypto_generichash_update(state, part);
  const digest = lib().crypto_generichash_final(state, out.byteLength);
  out.set(digest);
  lib().memzero(digest);
}

// Post-fill is done in the cases where someone caught an exception that
// happened before we were able to clear data at the end
export function hmac(out: Uint8Array, data: readonly Uint8Array[], key: Uint8Array): void {
  assert(out.byteLength === HASHLEN);
  assert(data.every((d) => d.byteLength >= 0));

  if (key.byteLength > BLOCKLEN) {
    generichashBatch(HMACKey.subarray(0, HASHLEN), [key]);
    lib().memzero(HMACKey.subarray(HASHLEN));
  } else {
    // Covers key <= BLOCKLEN
    HMACKey.set(key);
    lib().memzero(HMACKey.subarray(key.byteLength));
  }

  for (let i = 0; i < HMACKey.byteLength; i++) {
    OuterKeyPad[i] = 0x5c ^ (HMACKey[i] ?? 0);
    InnerKeyPad[i] = 0x36 ^ (HMACKey[i] ?? 0);
  }
  lib().memzero(HMACKey);

  generichashBatch(out, [InnerKeyPad, ...data]);
  lib().memzero(InnerKeyPad);
  generichashBatch(out, [OuterKeyPad, out]);
  lib().memzero(OuterKeyPad);
}

hmac.BYTES = HASHLEN;
hmac.KEYBYTES = BLOCKLEN;
