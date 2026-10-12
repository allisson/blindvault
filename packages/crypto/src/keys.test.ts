import { beforeAll, describe, expect, it } from 'vitest';

import { open, seal } from './aead';
import { EncodingError, KeyWipedError } from './errors';
import { KEY_LENGTH, Keyring, SymmetricKey, adoptKey, generateKey, keyBytes } from './keys';
import { initCrypto } from './sodium';
import { fromHex } from './test-helpers';

const AAD = fromHex('00000001ff');

beforeAll(initCrypto);

describe('Keyring', () => {
  it('generates distinct 32-byte keys', () => {
    const keyring = new Keyring();
    const a = generateKey(keyring);
    const b = generateKey(keyring);
    expect(keyBytes(a)).toHaveLength(KEY_LENGTH);
    expect(keyBytes(a)).not.toEqual(keyBytes(b));
    expect(keyring.size).toBe(2);
  });

  it('refuses a key that is not 32 bytes and zeroes what it was given', () => {
    const keyring = new Keyring();
    const short = new Uint8Array(31).fill(7);
    expect(() => adoptKey(keyring, short)).toThrow(EncodingError);
    expect(short.every((b) => b === 0)).toBe(true);
  });

  it('takes ownership of adopted bytes: wiping zeroes the caller-visible buffer', () => {
    const keyring = new Keyring();
    const bytes = new Uint8Array(32).fill(9);
    adoptKey(keyring, bytes);
    keyring.wipeAll();
    expect(bytes.every((b) => b === 0)).toBe(true);
  });

  it('blocks every operation with a key after wipeAll (CRYPTO-INV-010)', () => {
    const keyring = new Keyring();
    const key = generateKey(keyring);
    const sealed = seal(key, AAD, Uint8Array.of(1, 2, 3));
    keyring.wipeAll();
    expect(keyring.wiped).toBe(true);
    expect(keyring.size).toBe(0);
    expect(() => keyBytes(key)).toThrow(KeyWipedError);
    expect(() => seal(key, AAD, Uint8Array.of(1))).toThrow(KeyWipedError);
    expect(() => open(key, AAD, sealed)).toThrow(KeyWipedError);
  });

  it('refuses new keys once wiped, and zeroes them', () => {
    const keyring = new Keyring();
    keyring.wipeAll();
    const bytes = new Uint8Array(32).fill(5);
    expect(() => adoptKey(keyring, bytes)).toThrow(KeyWipedError);
    expect(bytes.every((b) => b === 0)).toBe(true);
    expect(() => generateKey(keyring)).toThrow(KeyWipedError);
  });

  it('releases one key without touching the others', () => {
    const keyring = new Keyring();
    const kept = generateKey(keyring);
    const released = generateKey(keyring);
    keyring.release(released);
    keyring.release(released);
    expect(() => keyBytes(released)).toThrow(KeyWipedError);
    expect(keyBytes(kept)).toHaveLength(KEY_LENGTH);
    expect(keyring.size).toBe(1);
  });

  it('ignores a key from another keyring on release', () => {
    const mine = new Keyring();
    const other = new Keyring();
    const key = generateKey(other);
    mine.release(key);
    expect(keyBytes(key)).toHaveLength(KEY_LENGTH);
  });
});

describe('SymmetricKey', () => {
  it('reveals no key bytes when logged or serialized (CRYPTO-INV-005)', () => {
    const keyring = new Keyring();
    const key = generateKey(keyring);
    expect(JSON.stringify({ key })).toBe('{"key":"[SymmetricKey]"}');
    expect(String(key)).toBe('[SymmetricKey]');
    expect(Object.keys(key)).toEqual([]);
    expect(Object.isFrozen(key)).toBe(true);
  });

  it('a handle with no key material cannot be used', () => {
    expect(() => keyBytes(SymmetricKey.create())).toThrow(KeyWipedError);
  });
});
