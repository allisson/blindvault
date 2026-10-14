// noise-protocol 3.0.2, symmetric-state.js (see LICENSE): the Noise SymmetricState, chaining key,
// handshake hash and CipherState in a single buffer.
// Deviations: `Uint8Array` instead of `sodium_malloc`, `memzero` from libsodium-wrappers-sumo;
// `assert` from ./assert; `hkdf` is called without the unused `dhlen` and `pklen` arguments, and
// `split` takes none.

import { lib } from '../sodium';
import { assert } from './assert';
import type { CipherState } from './cipher-state';
import type { Hash } from './hash';

export function createSymmetricState({
  hash,
  cipherState,
}: {
  hash: Hash;
  cipherState: CipherState;
}) {
  const STATELEN = hash.HASHLEN + hash.HASHLEN + cipherState.STATELEN;
  const HASHLEN = hash.HASHLEN;

  const CHAINING_KEY_BEGIN = 0;
  const CHAINING_KEY_END = hash.HASHLEN;
  const HASH_BEGIN = CHAINING_KEY_END;
  const HASH_END = HASH_BEGIN + hash.HASHLEN;
  const CIPHER_BEGIN = HASH_END;
  const CIPHER_END = CIPHER_BEGIN + cipherState.STATELEN;

  function initializeSymmetric(state: Uint8Array, protocolName: Uint8Array): void {
    assert(state.byteLength === STATELEN);

    lib().memzero(state);
    if (protocolName.byteLength <= HASHLEN) state.set(protocolName, HASH_BEGIN);
    else hash.hash(state.subarray(HASH_BEGIN, HASH_END), [protocolName]);

    state.subarray(CHAINING_KEY_BEGIN, CHAINING_KEY_END).set(state.subarray(HASH_BEGIN, HASH_END));

    cipherState.initializeKey(state.subarray(CIPHER_BEGIN, CIPHER_END), null);
  }

  const TempKey = new Uint8Array(HASHLEN);
  function mixKey(state: Uint8Array, inputKeyMaterial: Uint8Array): void {
    assert(state.byteLength === STATELEN);

    hash.hkdf(
      state.subarray(CHAINING_KEY_BEGIN, CHAINING_KEY_END),
      TempKey,
      null,
      state.subarray(CHAINING_KEY_BEGIN, CHAINING_KEY_END),
      inputKeyMaterial,
    );

    // HASHLEN is always 64 here, so we truncate to 32 bytes per the spec
    cipherState.initializeKey(state.subarray(CIPHER_BEGIN, CIPHER_END), TempKey.subarray(0, 32));
    lib().memzero(TempKey);
  }

  function mixHash(state: Uint8Array, data: Uint8Array): void {
    assert(state.byteLength === STATELEN);

    const h = state.subarray(HASH_BEGIN, HASH_END);

    hash.hash(h, [h, data]);
  }

  const TempHash = new Uint8Array(HASHLEN);
  function mixKeyAndHash(state: Uint8Array, inputKeyMaterial: Uint8Array): void {
    assert(state.byteLength === STATELEN);

    hash.hkdf(
      state.subarray(CHAINING_KEY_BEGIN, CHAINING_KEY_END),
      TempHash,
      TempKey,
      state.subarray(CHAINING_KEY_BEGIN, CHAINING_KEY_END),
      inputKeyMaterial,
    );

    mixHash(state, TempHash);
    lib().memzero(TempHash);

    // HASHLEN is always 64 here, so we truncate to 32 bytes per the spec
    cipherState.initializeKey(state.subarray(CIPHER_BEGIN, CIPHER_END), TempKey.subarray(0, 32));
    lib().memzero(TempKey);
  }

  function getHandshakeHash(state: Uint8Array, out: Uint8Array): void {
    assert(state.byteLength === STATELEN);
    assert(out.byteLength === HASHLEN);

    out.set(state.subarray(HASH_BEGIN, HASH_END));
  }

  // ciphertext is the output here
  function encryptAndHash(state: Uint8Array, ciphertext: Uint8Array, plaintext: Uint8Array): void {
    assert(state.byteLength === STATELEN);

    const cstate = state.subarray(CIPHER_BEGIN, CIPHER_END);
    const h = state.subarray(HASH_BEGIN, HASH_END);

    cipherState.encryptWithAd(cstate, ciphertext, h, plaintext);
    encryptAndHash.bytesRead = cipherState.encryptWithAd.bytesRead;
    encryptAndHash.bytesWritten = cipherState.encryptWithAd.bytesWritten;
    mixHash(state, ciphertext.subarray(0, encryptAndHash.bytesWritten));
  }
  encryptAndHash.bytesRead = 0;
  encryptAndHash.bytesWritten = 0;

  // plaintext is the output here
  function decryptAndHash(state: Uint8Array, plaintext: Uint8Array, ciphertext: Uint8Array): void {
    assert(state.byteLength === STATELEN);

    const cstate = state.subarray(CIPHER_BEGIN, CIPHER_END);
    const h = state.subarray(HASH_BEGIN, HASH_END);

    cipherState.decryptWithAd(cstate, plaintext, h, ciphertext);
    decryptAndHash.bytesRead = cipherState.decryptWithAd.bytesRead;
    decryptAndHash.bytesWritten = cipherState.decryptWithAd.bytesWritten;
    mixHash(state, ciphertext.subarray(0, decryptAndHash.bytesRead));
  }
  decryptAndHash.bytesRead = 0;
  decryptAndHash.bytesWritten = 0;

  const TempKey1 = new Uint8Array(HASHLEN);
  const TempKey2 = new Uint8Array(HASHLEN);
  const zerolen = new Uint8Array(0);
  function split(state: Uint8Array, cipherstate1: Uint8Array, cipherstate2: Uint8Array): void {
    assert(state.byteLength === STATELEN);
    assert(cipherstate1.byteLength === cipherState.STATELEN);
    assert(cipherstate2.byteLength === cipherState.STATELEN);

    hash.hkdf(
      TempKey1,
      TempKey2,
      null,
      state.subarray(CHAINING_KEY_BEGIN, CHAINING_KEY_END),
      zerolen,
    );

    // HASHLEN is always 64 here, so we truncate to 32 bytes per the spec
    cipherState.initializeKey(cipherstate1, TempKey1.subarray(0, 32));
    cipherState.initializeKey(cipherstate2, TempKey2.subarray(0, 32));
    lib().memzero(TempKey1);
    lib().memzero(TempKey2);
  }

  function _hasKey(state: Uint8Array): boolean {
    return cipherState.hasKey(state.subarray(CIPHER_BEGIN, CIPHER_END));
  }

  return {
    STATELEN,
    initializeSymmetric,
    mixKey,
    mixHash,
    mixKeyAndHash,
    getHandshakeHash,
    encryptAndHash,
    decryptAndHash,
    split,
    _hasKey,
  };
}

export type SymmetricState = ReturnType<typeof createSymmetricState>;
