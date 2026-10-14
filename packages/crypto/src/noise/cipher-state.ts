// noise-protocol 3.0.2, cipher-state.js (see LICENSE): the Noise CipherState, one key and one
// 64-bit little-endian nonce in a single buffer.
// Deviations: libsodium-wrappers-sumo instead of sodium-universal (`sodium_increment`,
// `sodium_memcmp`, `sodium_is_zero` and `sodium_memzero` are `increment`, `memcmp`, `is_zero` and
// `memzero`); `assert` from ./assert.

import { lib } from '../sodium';
import { assert } from './assert';
import type { Cipher } from './cipher';

export function createCipherState({ cipher }: { cipher: Cipher }) {
  const STATELEN = cipher.KEYLEN + cipher.NONCELEN;
  const NONCELEN = cipher.NONCELEN;
  const MACLEN = cipher.MACLEN;

  const KEY_BEGIN = 0;
  const KEY_END = cipher.KEYLEN;
  const NONCE_BEGIN = KEY_END;
  const NONCE_END = NONCE_BEGIN + cipher.NONCELEN;

  function initializeKey(state: Uint8Array, key: Uint8Array | null): void {
    assert(state.byteLength === STATELEN);
    assert(key == null ? true : key.byteLength === cipher.KEYLEN);

    if (key == null) {
      lib().memzero(state.subarray(KEY_BEGIN, KEY_END));
      return;
    }

    state.set(key);
    lib().memzero(state.subarray(NONCE_BEGIN, NONCE_END));
  }

  function hasKey(state: Uint8Array): boolean {
    assert(state.byteLength === STATELEN);
    const k = state.subarray(KEY_BEGIN, KEY_END);
    return !lib().is_zero(k);
  }

  function setNonce(state: Uint8Array, nonce: Uint8Array): void {
    assert(state.byteLength === STATELEN);
    assert(nonce.byteLength === NONCELEN);

    state.set(nonce, NONCE_BEGIN);
  }

  const maxnonce = new Uint8Array(8).fill(0xff);
  function encryptWithAd(
    state: Uint8Array,
    out: Uint8Array,
    ad: Uint8Array,
    plaintext: Uint8Array,
  ): void {
    assert(state.byteLength === STATELEN);

    const n = state.subarray(NONCE_BEGIN, NONCE_END);
    if (lib().memcmp(n, maxnonce)) throw new Error('Nonce overflow');

    if (!hasKey(state)) {
      out.set(plaintext);
      encryptWithAd.bytesRead = plaintext.byteLength;
      encryptWithAd.bytesWritten = encryptWithAd.bytesRead;
      return;
    }

    const k = state.subarray(KEY_BEGIN, KEY_END);

    cipher.encrypt(out, k, n, ad, plaintext);
    encryptWithAd.bytesRead = cipher.encrypt.bytesRead;
    encryptWithAd.bytesWritten = cipher.encrypt.bytesWritten;

    lib().increment(n);
  }
  encryptWithAd.bytesRead = 0;
  encryptWithAd.bytesWritten = 0;

  function decryptWithAd(
    state: Uint8Array,
    out: Uint8Array,
    ad: Uint8Array,
    ciphertext: Uint8Array,
  ): void {
    assert(state.byteLength === STATELEN);

    const n = state.subarray(NONCE_BEGIN, NONCE_END);
    if (lib().memcmp(n, maxnonce)) throw new Error('Nonce overflow');

    if (!hasKey(state)) {
      out.set(ciphertext);
      decryptWithAd.bytesRead = ciphertext.byteLength;
      decryptWithAd.bytesWritten = decryptWithAd.bytesRead;
      return;
    }

    const k = state.subarray(KEY_BEGIN, KEY_END);

    cipher.decrypt(out, k, n, ad, ciphertext);
    decryptWithAd.bytesRead = cipher.decrypt.bytesRead;
    decryptWithAd.bytesWritten = cipher.decrypt.bytesWritten;

    lib().increment(n);
  }
  decryptWithAd.bytesRead = 0;
  decryptWithAd.bytesWritten = 0;

  function rekey(state: Uint8Array): void {
    assert(state.byteLength === STATELEN);

    const k = state.subarray(KEY_BEGIN, KEY_END);
    cipher.rekey(k, k);
    rekey.bytesRead = cipher.rekey.bytesRead;
    rekey.bytesWritten = cipher.rekey.bytesWritten;
  }
  rekey.bytesRead = 0;
  rekey.bytesWritten = 0;

  return {
    STATELEN,
    NONCELEN,
    MACLEN,
    initializeKey,
    hasKey,
    setNonce,
    encryptWithAd,
    decryptWithAd,
    rekey,
  };
}

export type CipherState = ReturnType<typeof createCipherState>;
