// noise-protocol 3.0.2, cipher.js (see LICENSE): ChaChaPoly, ChaCha20-Poly1305 IETF with the
// 64-bit Noise nonce after 4 zero bytes.
// Deviations: libsodium-wrappers-sumo instead of sodium-universal, whose functions return new
// arrays, copied into `out` and then wiped (a failed decryption throws, as before); the lengths
// are the libsodium constants written out; `Uint8Array` instead of `sodium_malloc`; `assert`
// from ./assert.

import { lib } from '../sodium';
import { assert } from './assert';

const KEYLEN = 32;
const NONCELEN = 8;
const MACLEN = 16;
const ALG = 'ChaChaPoly';

const maxnonce = new Uint8Array(8).fill(0xff);
const zerolen = new Uint8Array(0);
const zeros = new Uint8Array(32);

// crypto_aead_chacha20poly1305_ietf_KEYBYTES === KEYLEN
// crypto_aead_chacha20poly1305_ietf_NPUBBYTES === 4 + NONCELEN
// crypto_aead_chacha20poly1305_ietf_ABYTES === MACLEN
const NPUBBYTES = 4 + NONCELEN;

export function createCipher() {
  return {
    KEYLEN,
    NONCELEN,
    MACLEN,
    ALG,
    encrypt,
    decrypt,
    rekey,
  };
}

export type Cipher = ReturnType<typeof createCipher>;

const ElongatedNonce = new Uint8Array(NPUBBYTES);
function encrypt(
  out: Uint8Array,
  k: Uint8Array,
  n: Uint8Array,
  ad: Uint8Array | null,
  plaintext: Uint8Array,
): void {
  assert(
    out.byteLength >= plaintext.byteLength + MACLEN,
    'output buffer must be at least plaintext plus MACLEN bytes long',
  );
  assert(k.byteLength === KEYLEN);
  assert(n.byteLength === NONCELEN);
  lib().memzero(ElongatedNonce);

  ElongatedNonce.set(n, 4);

  const sealed = lib().crypto_aead_chacha20poly1305_ietf_encrypt(
    plaintext,
    ad,
    null,
    ElongatedNonce,
    k,
  );
  out.subarray(0, plaintext.byteLength + MACLEN).set(sealed);
  encrypt.bytesWritten = sealed.byteLength;
  encrypt.bytesRead = encrypt.bytesWritten - MACLEN;

  lib().memzero(ElongatedNonce);
}
encrypt.bytesWritten = 0;
encrypt.bytesRead = 0;

function decrypt(
  out: Uint8Array,
  k: Uint8Array,
  n: Uint8Array,
  ad: Uint8Array | null,
  ciphertext: Uint8Array,
): void {
  assert(out.byteLength >= ciphertext.byteLength - MACLEN);
  assert(k.byteLength === KEYLEN);
  assert(n.byteLength === NONCELEN);
  lib().memzero(ElongatedNonce);

  ElongatedNonce.set(n, 4);

  const opened = lib().crypto_aead_chacha20poly1305_ietf_decrypt(
    null,
    ciphertext,
    ad,
    ElongatedNonce,
    k,
  );
  out.subarray(0, ciphertext.byteLength - MACLEN).set(opened);
  decrypt.bytesWritten = opened.byteLength;
  decrypt.bytesRead = decrypt.bytesWritten + MACLEN;
  lib().memzero(opened);

  lib().memzero(ElongatedNonce);
}
decrypt.bytesWritten = 0;
decrypt.bytesRead = 0;

const IntermediateKey = new Uint8Array(KEYLEN + MACLEN);
function rekey(out: Uint8Array, k: Uint8Array): void {
  assert(out.byteLength === KEYLEN);
  assert(k.byteLength === KEYLEN);
  lib().memzero(IntermediateKey);

  IntermediateKey.set(k);
  encrypt(IntermediateKey, k, maxnonce, zerolen, zeros);
  rekey.bytesWritten = encrypt.bytesWritten;
  rekey.bytesRead = encrypt.bytesRead;
  out.set(IntermediateKey.subarray(0, KEYLEN));
  lib().memzero(IntermediateKey);
}
rekey.bytesWritten = 0;
rekey.bytesRead = 0;
