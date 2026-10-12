import { beforeAll, describe, expect, it } from 'vitest';

import { seal } from './aead';
import { EncodingError, KeyWipedError } from './errors';
import { deviceId } from './ids';
import { generateDeviceIdentity, loadDeviceIdentity } from './identity';
import { Keyring, PrivateKey, generateKey, privateKeyBytes } from './keys';
import { initCrypto, lib } from './sodium';

beforeAll(initCrypto);

describe('device identity (D19, D67)', () => {
  it('generates an X25519 key pair whose deviceId is BLAKE2b-128 of the public key', () => {
    const keyring = new Keyring();
    const identity = generateDeviceIdentity(keyring);
    expect(identity.publicKey).toHaveLength(32);
    expect(identity.deviceId).toEqual(deviceId(identity.publicKey));
    expect(lib().crypto_scalarmult_base(privateKeyBytes(identity.privateKey))).toEqual(
      identity.publicKey,
    );
    expect(generateDeviceIdentity(keyring).deviceId).not.toEqual(identity.deviceId);
  });

  it('loads a stored identity and takes ownership of the private key', () => {
    const pair = lib().crypto_box_keypair();
    const keyring = new Keyring();
    const identity = loadDeviceIdentity(keyring, pair.publicKey, pair.privateKey);
    expect(identity.deviceId).toEqual(deviceId(pair.publicKey));
    keyring.wipeAll();
    expect(pair.privateKey.every((b) => b === 0)).toBe(true);
    expect(() => privateKeyBytes(identity.privateKey)).toThrow(KeyWipedError);
  });

  it('rejects a public key that is not the private key’s, and wipes the private key', () => {
    const pair = lib().crypto_box_keypair();
    const other = lib().crypto_box_keypair();
    const keyring = new Keyring();
    expect(() => loadDeviceIdentity(keyring, other.publicKey, pair.privateKey)).toThrow(
      EncodingError,
    );
    expect(pair.privateKey.every((b) => b === 0)).toBe(true);
    expect(keyring.size).toBe(0);
  });

  it.each([
    ['a short public key', new Uint8Array(31), new Uint8Array(32).fill(1)],
    ['a short private key', new Uint8Array(32), new Uint8Array(31).fill(1)],
  ])('rejects %s', (_name, publicKey, privateKey) => {
    expect(() => loadDeviceIdentity(new Keyring(), publicKey, privateKey)).toThrow(EncodingError);
    expect(privateKey.every((b) => b === 0)).toBe(true);
  });

  it('hides the private key from logs and JSON (CRYPTO-INV-005)', () => {
    const { privateKey } = generateDeviceIdentity(new Keyring());
    expect(JSON.stringify({ privateKey })).toBe('{"privateKey":"[PrivateKey]"}');
    expect(String(privateKey)).toBe('[PrivateKey]');
    expect(Object.keys(privateKey)).toEqual([]);
    expect(Object.isFrozen(privateKey)).toBe(true);
    expect(privateKey).toBeInstanceOf(PrivateKey);
  });

  it('refuses a new identity in a wiped keyring', () => {
    const keyring = new Keyring();
    keyring.wipeAll();
    expect(() => generateDeviceIdentity(keyring)).toThrow(KeyWipedError);
  });

  it('cannot pass a private key where a symmetric key is expected', () => {
    const { privateKey } = generateDeviceIdentity(new Keyring());
    // @ts-expect-error A PrivateKey is not a SymmetricKey.
    expect(() => seal(privateKey, new Uint8Array(1), new Uint8Array(0))).toThrow(EncodingError);
    const symmetric = generateKey(new Keyring());
    // @ts-expect-error A SymmetricKey is not a PrivateKey.
    expect(() => privateKeyBytes(symmetric)).toThrow(EncodingError);
  });
});
