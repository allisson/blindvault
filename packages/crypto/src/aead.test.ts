import { describe, expect, it } from 'vitest';

import { NONCE_LENGTH, TAG_LENGTH, open, seal, sealWithNonce, unwrapKey, wrapKey } from './aead';
import { DecryptionError, EncodingError, KeyWipedError } from './errors';
import { Keyring, adoptKey, generateKey, keyBytes } from './keys';
import { LocalPurpose, type RecordHeader, localAad, recordAad } from './layout';
import { initCrypto } from './sodium';
import { fromHex, toHex, vectorNonce, vectors } from './test-helpers';

// The `open rejects` table builds its keys at collection time.
await initCrypto();

const VAULT_ID = fromHex('a0a1a2a3a4a5a6a7a8a9aaabacadaeaf');
const LOCAL_CONFIG_ID = fromHex('b0b1b2b3b4b5b6b7b8b9babbbcbdbebf');

function key(keyring: Keyring, hex: string) {
  return adoptKey(keyring, fromHex(hex));
}

const header: RecordHeader = {
  recordFormatVersion: 1,
  recordType: 1,
  recordId: fromHex('c0c1c2c3c4c5c6c7c8c9cacbcccdcecf'),
  keyEpoch: 1,
  hlc: { physicalMs: 1_760_000_000_000, counter: 7, deviceId: new Uint8Array(16).fill(0x44) },
  deleted: false,
};

describe('AEAD vectors (crypto-spec.md §7, §12)', () => {
  it.each([
    [
      'device-kek',
      vectors.local.deviceKek,
      LocalPurpose.mkWrapDeviceKek,
      vectors.local.mkWrapDeviceKek,
      9,
    ],
    ['prf-kek', vectors.local.prfKek, LocalPurpose.mkWrapPrfKek, vectors.local.mkWrapPrfKek, 10],
  ] as const)(
    'reproduces and opens the Master Key wrap under the %s',
    (_name, kek, purpose, wrap, i) => {
      const keyring = new Keyring();
      const aad = localAad(purpose, VAULT_ID, LOCAL_CONFIG_ID);
      const masterKey = key(keyring, vectors.kdf.masterKey);
      const sealed = sealWithNonce(key(keyring, kek), aad, keyBytes(masterKey), vectorNonce(i));
      expect(toHex(sealed.n)).toBe(wrap.n);
      expect(toHex(sealed.c)).toBe(wrap.c);
      const opened = unwrapKey(keyring, key(keyring, kek), aad, {
        n: fromHex(wrap.n),
        c: fromHex(wrap.c),
      });
      expect(toHex(keyBytes(opened))).toBe(vectors.kdf.masterKey);
    },
  );

  it('opens the encrypted part of Local Config', () => {
    const keyring = new Keyring();
    const { n, c, plaintextCbor } = vectors.local.encryptedPart;
    const padded = open(
      key(keyring, vectors.local.localConfigKey),
      localAad(LocalPurpose.localConfig, VAULT_ID, LOCAL_CONFIG_ID),
      { n: fromHex(n), c: fromHex(c) },
    );
    expect(padded.length % 256).toBe(0);
    expect(toHex(padded).startsWith(plaintextCbor)).toBe(true);
  });

  it('reproduces the Vault Key record ciphertext (§10)', () => {
    const keyring = new Keyring();
    const r = vectors.records;
    const sealed = sealWithNonce(
      key(keyring, r.vaultKeyWrapKey),
      fromHex(r.vaultKeyRecord.aad),
      fromHex(r.vaultKey),
      vectorNonce(5),
    );
    expect(sealed.c).toHaveLength(48);
    expect(r.vaultKeyRecord.envelope).toContain(toHex(sealed.c));
  });

  it('reproduces the item wrapped record key (§9.3)', () => {
    const keyring = new Keyring();
    const r = vectors.records;
    const wk = sealWithNonce(
      key(keyring, r.vaultKey),
      fromHex(r.item.aad),
      fromHex(r.item.recordKey),
      vectorNonce(1),
    );
    expect(r.item.envelope).toContain(toHex(wk.c));
  });

  it.each([...vectors.records.mustNotOpen, ...vectors.local.mustNotOpen])(
    'must not open: $case',
    (v) => {
      const keyring = new Keyring();
      expect(() =>
        open(key(keyring, v.key), fromHex(v.aad), { n: fromHex(v.n), c: fromHex(v.c) }),
      ).toThrow(DecryptionError);
    },
  );
});

describe('seal and open', () => {
  it('round-trips under a fresh random nonce each time', () => {
    const keyring = new Keyring();
    const k = generateKey(keyring);
    const aad = recordAad(header, VAULT_ID);
    const plaintext = Uint8Array.of(1, 2, 3, 4);
    const a = seal(k, aad, plaintext);
    const b = seal(k, aad, plaintext);
    expect(a.n).toHaveLength(NONCE_LENGTH);
    expect(a.c).toHaveLength(plaintext.length + TAG_LENGTH);
    expect(toHex(a.n)).not.toBe(toHex(b.n));
    expect(open(k, aad, a)).toEqual(plaintext);
    expect(open(k, aad, b)).toEqual(plaintext);
  });

  it('seals empty plaintext to a bare tag (purged tombstone, D27)', () => {
    const keyring = new Keyring();
    const k = generateKey(keyring);
    const aad = recordAad({ ...header, deleted: true }, VAULT_ID);
    const sealed = seal(k, aad, new Uint8Array(0));
    expect(sealed.c).toHaveLength(TAG_LENGTH);
    expect(open(k, aad, sealed)).toHaveLength(0);
  });

  it('requires AAD on both sides', () => {
    const keyring = new Keyring();
    const k = generateKey(keyring);
    const sealed = seal(k, recordAad(header, VAULT_ID), Uint8Array.of(1));
    expect(() => seal(k, new Uint8Array(0), Uint8Array.of(1))).toThrow(EncodingError);
    expect(() => open(k, new Uint8Array(0), sealed)).toThrow(EncodingError);
  });

  it('refuses a fixed nonce that is not 24 bytes', () => {
    const keyring = new Keyring();
    expect(() =>
      sealWithNonce(
        generateKey(keyring),
        recordAad(header, VAULT_ID),
        Uint8Array.of(1),
        new Uint8Array(12),
      ),
    ).toThrow(EncodingError);
  });
});

describe('open rejects (Gate A)', () => {
  const keyring = new Keyring();
  const k = generateKey(keyring);
  const aad = recordAad(header, VAULT_ID);
  const sealed = seal(k, aad, Uint8Array.of(10, 20, 30, 40));

  function flipped(bytes: Uint8Array, index: number): Uint8Array {
    const out = bytes.slice();
    out[index] = (out[index] ?? 0) ^ 0x01;
    return out;
  }

  it.each<[string, () => Uint8Array]>([
    ['a tampered ciphertext byte', () => open(k, aad, { n: sealed.n, c: flipped(sealed.c, 0) })],
    [
      'an invalid tag',
      () => open(k, aad, { n: sealed.n, c: flipped(sealed.c, sealed.c.length - 1) }),
    ],
    ['a tampered nonce', () => open(k, aad, { n: flipped(sealed.n, 0), c: sealed.c })],
    [
      'a truncated ciphertext',
      () => open(k, aad, { n: sealed.n, c: sealed.c.subarray(0, sealed.c.length - 1) }),
    ],
    [
      'ciphertext shorter than a tag',
      () => open(k, aad, { n: sealed.n, c: sealed.c.subarray(0, TAG_LENGTH - 1) }),
    ],
    ['a short nonce', () => open(k, aad, { n: sealed.n.subarray(0, 23), c: sealed.c })],
    ['another key', () => open(generateKey(keyring), aad, sealed)],
    [
      'a wrong keyEpoch in the AAD',
      () => open(k, recordAad({ ...header, keyEpoch: 2 }, VAULT_ID), sealed),
    ],
    [
      'a swapped recordId',
      () => open(k, recordAad({ ...header, recordId: new Uint8Array(16) }, VAULT_ID), sealed),
    ],
    [
      'an edited hlc',
      () => open(k, recordAad({ ...header, hlc: { ...header.hlc, counter: 8 } }, VAULT_ID), sealed),
    ],
    [
      'an edited deleted flag',
      () => open(k, recordAad({ ...header, deleted: true }, VAULT_ID), sealed),
    ],
    ['another vaultId', () => open(k, recordAad(header, new Uint8Array(16)), sealed)],
    [
      'an unknown recordFormatVersion',
      () => open(k, recordAad({ ...header, recordFormatVersion: 2 }, VAULT_ID), sealed),
    ],
  ])('%s', (_name, attempt) => {
    expect(attempt).toThrow(DecryptionError);
  });
});

describe('key wraps (D8)', () => {
  it('wraps and unwraps a key bound to its AAD', () => {
    const keyring = new Keyring();
    const vaultKey = generateKey(keyring);
    const recordKey = generateKey(keyring);
    const aad = recordAad(header, VAULT_ID);
    const wrapped = wrapKey(vaultKey, aad, recordKey);
    expect(wrapped.c).toHaveLength(48);
    expect(keyBytes(unwrapKey(keyring, vaultKey, aad, wrapped))).toEqual(keyBytes(recordKey));
    expect(() =>
      unwrapKey(keyring, vaultKey, recordAad({ ...header, deleted: true }, VAULT_ID), wrapped),
    ).toThrow(DecryptionError);
  });

  it('rejects an authenticated plaintext that is not a 32-byte key', () => {
    const keyring = new Keyring();
    const k = generateKey(keyring);
    const aad = recordAad(header, VAULT_ID);
    expect(() => unwrapKey(keyring, k, aad, seal(k, aad, new Uint8Array(31)))).toThrow(
      DecryptionError,
    );
    expect(() => unwrapKey(keyring, k, aad, seal(k, aad, new Uint8Array(33)))).toThrow(
      DecryptionError,
    );
  });

  it('refuses to unwrap into a wiped keyring', () => {
    const live = new Keyring();
    const locked = new Keyring();
    const k = generateKey(live);
    const aad = recordAad(header, VAULT_ID);
    const wrapped = wrapKey(k, aad, generateKey(live));
    locked.wipeAll();
    expect(() => unwrapKey(locked, k, aad, wrapped)).toThrow(KeyWipedError);
  });
});
