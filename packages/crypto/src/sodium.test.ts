import { describe, expect, it } from 'vitest';

import { CryptoNotReadyError, EncodingError } from './errors';
import { ID_LENGTH, initCrypto, lib, randomBytes, randomId } from './sodium';

describe('libsodium initialization', () => {
  it('refuses every operation before initCrypto() resolves', () => {
    expect(() => lib()).toThrow(CryptoNotReadyError);
    expect(() => randomBytes(32)).toThrow(CryptoNotReadyError);
    expect(() => randomId()).toThrow(CryptoNotReadyError);
  });

  it('works once initialized, and initializing again is harmless', async () => {
    await initCrypto();
    await initCrypto();
    expect(typeof lib().crypto_aead_xchacha20poly1305_ietf_encrypt).toBe('function');
  });
});

describe('RNG', () => {
  it('returns the requested number of bytes, different on every call', async () => {
    await initCrypto();
    const a = randomBytes(32);
    const b = randomBytes(32);
    expect(a).toHaveLength(32);
    expect(lib().memcmp(a, b)).toBe(false);
  });

  it('makes 16-byte IDs', async () => {
    await initCrypto();
    expect(randomId()).toHaveLength(ID_LENGTH);
  });

  it.each([0, -1, 1.5, Number.NaN, 2 ** 53])('rejects length %s', async (length) => {
    await initCrypto();
    expect(() => randomBytes(length)).toThrow(EncodingError);
  });
});
