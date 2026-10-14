// noise-protocol 3.0.2, dh.js (see LICENSE): X25519.
// Deviations: libsodium-wrappers-sumo instead of sodium-universal, whose functions return new
// arrays, copied into the caller's buffers and then wiped; the lengths are the libsodium constants
// written out; `assert` from ./assert; no `generateSeedKeypair` (the copy has no `seedKeygen`).

import { lib } from '../sodium';
import { assert } from './assert';

const DHLEN = 32; // crypto_scalarmult_BYTES
const PKLEN = 32; // crypto_scalarmult_BYTES
const SKLEN = 32; // crypto_scalarmult_SCALARBYTES
const ALG = '25519';

export interface Dh {
  readonly DHLEN: number;
  readonly PKLEN: number;
  readonly SKLEN: number;
  readonly ALG: string;
  generateKeypair(pk: Uint8Array, sk: Uint8Array): void;
  dh(output: Uint8Array, lsk: Uint8Array, pk: Uint8Array): void;
}

export function createDh(): Dh {
  return {
    DHLEN,
    PKLEN,
    SKLEN,
    ALG,
    generateKeypair,
    dh,
  };
}

function generateKeypair(pk: Uint8Array, sk: Uint8Array): void {
  assert(pk.byteLength === PKLEN);
  assert(sk.byteLength === SKLEN);
  const pair = lib().crypto_kx_keypair();
  pk.set(pair.publicKey);
  sk.set(pair.privateKey);
  lib().memzero(pair.privateKey);
}

function dh(output: Uint8Array, lsk: Uint8Array, pk: Uint8Array): void {
  assert(output.byteLength === DHLEN);
  assert(lsk.byteLength === SKLEN);
  assert(pk.byteLength === PKLEN);

  // Throws on an all-zero result, a low-order public key, as crypto_scalarmult does.
  const shared = lib().crypto_scalarmult(lsk, pk);
  output.set(shared);
  lib().memzero(shared);
}
