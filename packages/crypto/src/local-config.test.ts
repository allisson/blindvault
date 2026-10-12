import { beforeAll, describe, expect, it } from 'vitest';

import { seal } from './aead';
import { type CborMap, type CborValue, encodeCbor } from './cbor';
import { DecryptionError, EncodingError } from './errors';
import { generateDeviceIdentity } from './identity';
import { Keyring, adoptKey, generateKey, privateKeyBytes } from './keys';
import { LocalPurpose, localAad } from './layout';
import { openLocalConfigPart, sealLocalConfigPart } from './local-config';
import { pad } from './pad';
import { initCrypto, lib } from './sodium';
import { fromHex, toHex, vectors } from './test-helpers';

beforeAll(initCrypto);

const VAULT_ID = fromHex('a0a1a2a3a4a5a6a7a8a9aaabacadaeaf');
const LOCAL_CONFIG_ID = fromHex('b0b1b2b3b4b5b6b7b8b9babbbcbdbebf');
const AAD = () => localAad(LocalPurpose.localConfig, VAULT_ID, LOCAL_CONFIG_ID);

function content(): CborMap {
  return new Map<CborValue, CborValue>([
    ['hlc', [1_760_000_000_000, 3, new Uint8Array(16).fill(0x44)]],
    ['lastPhraseId', new Uint8Array(16).fill(0xe0)],
  ]);
}

function sealRaw(key: ReturnType<typeof generateKey>, value: CborValue): ReturnType<typeof seal> {
  return seal(key, AAD(), pad(encodeCbor(value)));
}

describe('Local Config encrypted part (crypto-spec.md §12, D67)', () => {
  it('opens the vector and loads its device identity', () => {
    const keyring = new Keyring();
    const { n, c } = vectors.local.encryptedPart;
    const opened = openLocalConfigPart(
      keyring,
      adoptKey(keyring, fromHex(vectors.local.localConfigKey)),
      AAD(),
      { n: fromHex(n), c: fromHex(c) },
    );
    expect(toHex(opened.identity.publicKey)).toBe(vectors.ids.deviceId.staticPublicKey);
    expect(toHex(opened.identity.deviceId)).toBe(vectors.ids.deviceId.deviceId);
    expect(toHex(privateKeyBytes(opened.identity.privateKey))).toBe(
      vectors.ids.deviceId.staticSecretKey,
    );
    expect(opened.content.has('deviceIdentity')).toBe(false);
    expect([...opened.content.keys()].sort()).toEqual(['hlc', 'preferences']);
  });

  it('round-trips, returning byte strings that survive the wipe of the plaintext', () => {
    const keyring = new Keyring();
    const key = generateKey(keyring);
    const identity = generateDeviceIdentity(keyring);
    const sealed = sealLocalConfigPart(key, AAD(), content(), identity);
    expect((sealed.c.length - 16) % 256).toBe(0);
    const opened = openLocalConfigPart(keyring, key, AAD(), sealed);
    expect(opened.content).toEqual(content());
    expect(opened.identity.publicKey).toEqual(identity.publicKey);
    expect(privateKeyBytes(opened.identity.privateKey)).toEqual(
      privateKeyBytes(identity.privateKey),
    );
  });

  it('refuses content that already holds a device identity', () => {
    const keyring = new Keyring();
    const map = content();
    map.set('deviceIdentity', new Map());
    expect(() =>
      sealLocalConfigPart(generateKey(keyring), AAD(), map, generateDeviceIdentity(keyring)),
    ).toThrow(EncodingError);
  });

  it('rejects the part of another Local Config (CRYPTO-INV-023)', () => {
    const keyring = new Keyring();
    const key = generateKey(keyring);
    const sealed = sealLocalConfigPart(key, AAD(), content(), generateDeviceIdentity(keyring));
    const other = localAad(LocalPurpose.localConfig, VAULT_ID, new Uint8Array(16));
    expect(() => openLocalConfigPart(keyring, key, other, sealed)).toThrow(DecryptionError);
  });

  it.each<[string, (pk: Uint8Array, sk: Uint8Array) => CborValue | Uint8Array]>([
    ['unpadded plaintext', () => new Uint8Array(255)],
    ['a value that is not a map', () => [1, 2]],
    ['no device identity', () => new Map([['hlc', 1]])],
    [
      'an identity with an extra key',
      (pk, sk) =>
        new Map([
          [
            'deviceIdentity',
            new Map<CborValue, CborValue>([
              ['publicKey', pk],
              ['privateKey', sk],
              ['x', 1],
            ]),
          ],
        ]),
    ],
    [
      'a private key that is text',
      (pk) =>
        new Map([
          [
            'deviceIdentity',
            new Map<CborValue, CborValue>([
              ['publicKey', pk],
              ['privateKey', 'secret'],
            ]),
          ],
        ]),
    ],
    [
      'a public key that is not the private key’s',
      (_pk, sk) =>
        new Map([
          [
            'deviceIdentity',
            new Map<CborValue, CborValue>([
              ['publicKey', new Uint8Array(32).fill(9)],
              ['privateKey', sk],
            ]),
          ],
        ]),
    ],
  ])('rejects %s', (_name, build) => {
    const keyring = new Keyring();
    const key = generateKey(keyring);
    const pair = lib().crypto_box_keypair();
    const value = build(pair.publicKey, pair.privateKey);
    const sealed =
      value instanceof Uint8Array && value.length === 255
        ? seal(key, AAD(), value)
        : sealRaw(key, value);
    expect(() => openLocalConfigPart(keyring, key, AAD(), sealed)).toThrow(EncodingError);
    expect(keyring.size).toBe(1);
  });
});
