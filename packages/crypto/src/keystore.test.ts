import { beforeAll, describe, expect, it } from 'vitest';

import { unwrapKey } from './aead';
import { DecryptionError, EncodingError } from './errors';
import { Keyring, keyBytes } from './keys';
import { KEYSTORE_SECRET_LENGTH, deriveKeystoreKek, generateKeystoreSecret } from './keystore';
import { LocalPurpose, localAad } from './layout';
import { initCrypto } from './sodium';
import { fromHex, toHex, vectors } from './test-helpers';

beforeAll(initCrypto);

const VAULT_ID = fromHex('a0a1a2a3a4a5a6a7a8a9aaabacadaeaf');
const LOCAL_CONFIG_ID = fromHex('b0b1b2b3b4b5b6b7b8b9babbbcbdbebf');
const wrap = () => ({
  n: fromHex(vectors.local.mkWrapKeystoreKek.n),
  c: fromHex(vectors.local.mkWrapKeystoreKek.c),
});

describe('Keystore KEK (crypto-spec.md §5.3, D290, CRYPTO-INV-028)', () => {
  it('derives the vector Keystore KEK and wipes the secret', () => {
    const keyring = new Keyring();
    const secret = fromHex(vectors.kdf.keystoreSecret);
    const kek = deriveKeystoreKek(keyring, secret);
    expect(toHex(keyBytes(kek))).toBe(vectors.local.keystoreKek);
    expect(secret.every((b) => b === 0)).toBe(true);
    expect(keyring.size).toBe(1);
  });

  it.each([0, 31, 33, 48])(
    'refuses a secret of %i bytes before any derivation, and wipes it',
    (length) => {
      const keyring = new Keyring();
      const secret = new Uint8Array(length).fill(0x55);
      expect(() => deriveKeystoreKek(keyring, secret)).toThrow(EncodingError);
      expect(secret.every((b) => b === 0)).toBe(true);
      expect(keyring.size).toBe(0);
    },
  );

  it('opens the vector Master Key wrap only under its own purpose and identity', () => {
    const keyring = new Keyring();
    const kek = deriveKeystoreKek(keyring, fromHex(vectors.kdf.keystoreSecret));
    const own = localAad(LocalPurpose.mkWrapKeystoreKek, VAULT_ID, LOCAL_CONFIG_ID);
    expect(toHex(keyBytes(unwrapKey(keyring, kek, own, wrap())))).toBe(vectors.kdf.masterKey);
    for (const aad of [
      localAad(LocalPurpose.mkWrapPrfKek, VAULT_ID, LOCAL_CONFIG_ID),
      localAad(LocalPurpose.mkWrapDeviceKek, VAULT_ID, LOCAL_CONFIG_ID),
      localAad(LocalPurpose.mkWrapKeystoreKek, LOCAL_CONFIG_ID, LOCAL_CONFIG_ID),
      localAad(LocalPurpose.mkWrapKeystoreKek, VAULT_ID, VAULT_ID),
    ]) {
      expect(() => unwrapKey(keyring, kek, aad, wrap())).toThrow(DecryptionError);
    }
  });

  it('opens nothing with the KEK of another secret', () => {
    const keyring = new Keyring();
    const other = new Uint8Array(32).fill(0x91);
    const kek = deriveKeystoreKek(keyring, other);
    const aad = localAad(LocalPurpose.mkWrapKeystoreKek, VAULT_ID, LOCAL_CONFIG_ID);
    expect(() => unwrapKey(keyring, kek, aad, wrap())).toThrow(DecryptionError);
  });

  it('generates a random 32-byte secret', () => {
    expect(generateKeystoreSecret()).toHaveLength(KEYSTORE_SECRET_LENGTH);
    expect(generateKeystoreSecret()).not.toEqual(generateKeystoreSecret());
  });
});
