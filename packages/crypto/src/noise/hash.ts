// noise-protocol 3.0.2, hash.js (see LICENSE): BLAKE2b and the Noise HKDF.
// Deviations: libsodium-wrappers-sumo instead of sodium-universal (`crypto_generichash_batch` is
// `generichashBatch`); `Uint8Array` instead of `sodium_malloc`; `assert` from ./assert.

import { lib } from '../sodium';
import { assert } from './assert';
import type { Dh } from './dh';
import { generichashBatch, hmac as hmacBlake2b } from './hmac-blake2b';

const HASHLEN = 64;
const BLOCKLEN = 128;
const ALG = 'BLAKE2b';

assert(hmacBlake2b.KEYBYTES === BLOCKLEN, 'mismatching hmac BLOCKLEN');
assert(hmacBlake2b.BYTES === HASHLEN, 'mismatching hmac HASHLEN');

const TempKey = new Uint8Array(HASHLEN);
const Byte0x01 = new Uint8Array([0x01]);
const Byte0x02 = new Uint8Array([0x02]);
const Byte0x03 = new Uint8Array([0x03]);

export interface Hash {
  readonly HASHLEN: number;
  readonly BLOCKLEN: number;
  readonly ALG: string;
  hash(out: Uint8Array, data: readonly Uint8Array[]): void;
  hkdf(
    out1: Uint8Array,
    out2: Uint8Array,
    out3: Uint8Array | null,
    chainingKey: Uint8Array,
    inputKeyMaterial: Uint8Array,
  ): void;
}

export function createHash({ dh }: { dh: Dh }): Hash {
  return {
    HASHLEN,
    BLOCKLEN,
    ALG,
    hash,
    hkdf,
  };

  function hkdf(
    out1: Uint8Array,
    out2: Uint8Array,
    out3: Uint8Array | null,
    chainingKey: Uint8Array,
    inputKeyMaterial: Uint8Array,
  ): void {
    assert(out1.byteLength === HASHLEN);
    assert(out2.byteLength === HASHLEN);
    assert(out3 == null ? true : out3.byteLength === HASHLEN);
    assert(chainingKey.byteLength === HASHLEN);
    assert([0, 32, dh.DHLEN, dh.PKLEN].includes(inputKeyMaterial.byteLength));

    lib().memzero(TempKey);
    hmac(TempKey, chainingKey, [inputKeyMaterial]);
    hmac(out1, TempKey, [Byte0x01]);
    hmac(out2, TempKey, [out1, Byte0x02]);

    if (out3 != null) {
      hmac(out3, TempKey, [out2, Byte0x03]);
    }

    lib().memzero(TempKey);
  }
}

function hash(out: Uint8Array, data: readonly Uint8Array[]): void {
  assert(out.byteLength === HASHLEN);
  assert(Array.isArray(data));

  generichashBatch(out, data);
}

function hmac(out: Uint8Array, key: Uint8Array, data: readonly Uint8Array[]): void {
  hmacBlake2b(out, data, key);
}
