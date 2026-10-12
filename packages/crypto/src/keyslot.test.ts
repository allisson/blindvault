import { beforeAll, describe, expect, it } from 'vitest';

import { DecryptionError, EncodingError, KeyWipedError } from './errors';
import { Keyring, adoptKey, generateKey, keyBytes } from './keys';
import { PASSWORD_KEYSLOT_AAD, SEALED_KEY_LENGTH, openSealedKey, sealKeyTo } from './keyslot';
import { deriveRecoveryKeys, generateRecoveryPhrase } from './recovery';
import { initCrypto, lib } from './sodium';
import { fromHex, toHex, vectors } from './test-helpers';

beforeAll(initCrypto);

function recoveryPair(keyring: Keyring) {
  const phrase = generateRecoveryPhrase(keyring);
  return deriveRecoveryKeys(keyring, phrase.entropy);
}

describe('backup keyslots (backup-format.md §3, D16)', () => {
  it('fixes the password keyslot AAD', () => {
    expect(toHex(PASSWORD_KEYSLOT_AAD)).toBe(
      toHex(
        Uint8Array.of(0, 0, 0, 29, ...new TextEncoder().encode('bv.bvault.v1.keyslot.password')),
      ),
    );
  });

  it('seals a key to the recovery keyslot public key and opens it with the phrase', () => {
    const keyring = new Keyring();
    const keys = recoveryPair(keyring);
    const fileKey = generateKey(keyring);
    const sealed = sealKeyTo(keys.keyslotPublicKey, fileKey);
    expect(sealed).toHaveLength(SEALED_KEY_LENGTH);
    const opened = openSealedKey(keyring, keys.keyslotPublicKey, keys.keyslotPrivateKey, sealed);
    expect(keyBytes(opened)).toEqual(keyBytes(fileKey));
    expect(opened).not.toBe(fileKey);
    // A new ephemeral key every time.
    expect(sealKeyTo(keys.keyslotPublicKey, fileKey)).not.toEqual(sealed);
  });

  it('opens with the vector key pair', () => {
    const keyring = new Keyring();
    const pair = vectors.kdf.keyslotKeyPair;
    const fileKey = generateKey(keyring);
    const sealed = sealKeyTo(fromHex(pair.publicKey), fileKey);
    const opened = openSealedKey(
      keyring,
      fromHex(pair.publicKey),
      keyring.adoptPrivate(fromHex(pair.secretKey)),
      sealed,
    );
    expect(keyBytes(opened)).toEqual(keyBytes(fileKey));
  });

  it('fails the same way for another phrase, a changed byte or a wrong length', () => {
    const keyring = new Keyring();
    const keys = recoveryPair(keyring);
    const other = recoveryPair(keyring);
    const sealed = sealKeyTo(keys.keyslotPublicKey, generateKey(keyring));
    const flipped = sealed.slice();
    flipped[40] = (flipped[40] ?? 0) ^ 1;
    const before = keyring.size;
    for (const [pk, sk, box] of [
      [other.keyslotPublicKey, other.keyslotPrivateKey, sealed],
      [keys.keyslotPublicKey, other.keyslotPrivateKey, sealed],
      [keys.keyslotPublicKey, keys.keyslotPrivateKey, flipped],
      [keys.keyslotPublicKey, keys.keyslotPrivateKey, sealed.subarray(1)],
      [keys.keyslotPublicKey.subarray(1), keys.keyslotPrivateKey, sealed],
    ] as const) {
      expect(() => openSealedKey(keyring, pk, sk, box)).toThrow(DecryptionError);
    }
    expect(keyring.size).toBe(before);
  });

  it('refuses a sealed box that does not hold a 32-byte key', () => {
    const keyring = new Keyring();
    const keys = recoveryPair(keyring);
    const short = lib().crypto_box_seal(new Uint8Array(31), keys.keyslotPublicKey);
    expect(() =>
      openSealedKey(keyring, keys.keyslotPublicKey, keys.keyslotPrivateKey, short),
    ).toThrow(DecryptionError);
  });

  it('refuses a public key that is not 32 bytes, and wiped keys', () => {
    const keyring = new Keyring();
    const keys = recoveryPair(keyring);
    const fileKey = adoptKey(keyring, new Uint8Array(32).fill(9));
    expect(() => sealKeyTo(new Uint8Array(31), fileKey)).toThrow(EncodingError);
    const sealed = sealKeyTo(keys.keyslotPublicKey, fileKey);
    keyring.wipeAll();
    expect(() => sealKeyTo(keys.keyslotPublicKey, fileKey)).toThrow(KeyWipedError);
    expect(() =>
      openSealedKey(new Keyring(), keys.keyslotPublicKey, keys.keyslotPrivateKey, sealed),
    ).toThrow(KeyWipedError);
  });
});
