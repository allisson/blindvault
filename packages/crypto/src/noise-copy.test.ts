// The copied Noise code (./noise, D157, D200) checked against independent implementations where
// the official vectors do not reach: Node's HMAC-BLAKE2b and BLAKE2b, and the Noise spec's REKEY.

import { createHash, createHmac } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import { NoiseAssertionError, assert, required } from './noise/assert';
import { createDh } from './noise/dh';
import { hmac } from './noise/hmac-blake2b';
import { bindNoise } from './noise/index';
import { initCrypto, lib } from './sodium';
import { toHex } from './test-helpers';

beforeAll(initCrypto);

const bytes = (length: number, seed: number) =>
  Uint8Array.from({ length }, (_, i) => (i * 13 + seed) & 0xff);

describe('hmac-blake2b', () => {
  it.each([0, 32, 64, 128, 129, 300])('matches HMAC-BLAKE2b-512 with a %i-byte key', (length) => {
    const key = bytes(length, 1);
    const parts = [bytes(10, 2), bytes(0, 0), bytes(200, 3)];
    const out = new Uint8Array(64);
    hmac(out, parts, key);
    const expected = createHmac('blake2b512', key);
    for (const part of parts) expected.update(part);
    expect(toHex(out)).toBe(expected.digest('hex'));
  });
});

describe('symmetric state', () => {
  const { symmetricState } = bindNoise();

  it('hashes a protocol name longer than 64 bytes', () => {
    const name = new TextEncoder().encode('Noise_'.padEnd(80, 'x'));
    const state = new Uint8Array(symmetricState.STATELEN);
    symmetricState.initializeSymmetric(state, name);
    const h = new Uint8Array(64);
    symmetricState.getHandshakeHash(state, h);
    expect(toHex(h)).toBe(createHash('blake2b512').update(name).digest('hex'));
  });

  it('mixKeyAndHash follows the Noise spec, three HKDF outputs', () => {
    const state = new Uint8Array(symmetricState.STATELEN);
    symmetricState.initializeSymmetric(state, new TextEncoder().encode('Noise_test'));
    const ck = state.slice(0, 64);
    const h = state.slice(64, 128);
    const ikm = bytes(32, 5);
    symmetricState.mixKeyAndHash(state, ikm);

    const hmacB = (key: Uint8Array, ...data: Uint8Array[]) => {
      const m = createHmac('blake2b512', key);
      for (const d of data) m.update(d);
      return new Uint8Array(m.digest());
    };
    const temp = hmacB(ck, ikm);
    const out1 = hmacB(temp, Uint8Array.of(1));
    const out2 = hmacB(temp, out1, Uint8Array.of(2));
    const out3 = hmacB(temp, out2, Uint8Array.of(3));
    const newH = createHash('blake2b512').update(h).update(out2).digest('hex');

    expect(toHex(state.slice(0, 64))).toBe(toHex(out1));
    expect(toHex(state.slice(64, 128))).toBe(newH);
    expect(toHex(state.slice(128, 160))).toBe(toHex(out3.slice(0, 32)));
  });

  it('refuses input key material of another length', () => {
    const state = new Uint8Array(symmetricState.STATELEN);
    expect(() => {
      symmetricState.mixKey(state, new Uint8Array(5));
    }).toThrow(NoiseAssertionError);
  });
});

describe('cipher state', () => {
  const { cipherState } = bindNoise();
  const keyed = () => {
    const state = new Uint8Array(cipherState.STATELEN);
    cipherState.initializeKey(state, bytes(32, 9));
    return state;
  };

  it('rekey is the first 32 bytes of ENCRYPT(k, 2^64 − 1, empty, zeros)', () => {
    const state = keyed();
    const k = state.slice(0, 32);
    cipherState.rekey(state);
    const nonce = new Uint8Array(12);
    nonce.fill(0xff, 4);
    const expected = lib()
      .crypto_aead_chacha20poly1305_ietf_encrypt(
        new Uint8Array(32),
        new Uint8Array(0),
        null,
        nonce,
        k,
      )
      .slice(0, 32);
    expect(toHex(state.slice(0, 32))).toBe(toHex(expected));
    expect(cipherState.rekey.bytesWritten).toBe(48);
  });

  it('refuses to use the nonce 2^64 − 1', () => {
    const state = keyed();
    cipherState.setNonce(state, new Uint8Array(8).fill(0xff));
    const out = new Uint8Array(32);
    expect(() => {
      cipherState.encryptWithAd(state, out, new Uint8Array(0), new Uint8Array(1));
    }).toThrow('Nonce overflow');
    expect(() => {
      cipherState.decryptWithAd(state, out, new Uint8Array(0), new Uint8Array(17));
    }).toThrow('Nonce overflow');
  });

  it('has no key after initializeKey(null)', () => {
    const state = new Uint8Array(cipherState.STATELEN);
    cipherState.initializeKey(state, null);
    expect(cipherState.hasKey(state)).toBe(false);
  });
});

describe('dh', () => {
  it('generates X25519 key pairs that agree', () => {
    const dh = createDh();
    const [pa, sa, pb, sb] = [32, 32, 32, 32].map((n) => new Uint8Array(n)) as [
      Uint8Array,
      Uint8Array,
      Uint8Array,
      Uint8Array,
    ];
    dh.generateKeypair(pa, sa);
    dh.generateKeypair(pb, sb);
    const ab = new Uint8Array(32);
    const ba = new Uint8Array(32);
    dh.dh(ab, sa, pb);
    dh.dh(ba, sb, pa);
    expect(toHex(ab)).toBe(toHex(ba));
    expect(toHex(pa)).toBe(toHex(lib().crypto_scalarmult_base(sa)));
  });
});

describe('assert', () => {
  it('throws its message, and required() refuses null', () => {
    expect(() => {
      assert(false, 'x');
    }).toThrow('x');
    expect(() => required(null)).toThrow(NoiseAssertionError);
  });
});
