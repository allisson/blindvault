import { beforeAll, describe, expect, it } from 'vitest';

import { KdfContext, deriveMasterSubkeys, deriveSubkey, isMasterKeyOf } from './kdf';
import { Keyring, adoptKey, generateKey, keyBytes } from './keys';
import { initCrypto } from './sodium';
import { fromHex, toHex, vectors } from './test-helpers';

beforeAll(initCrypto);

const kdf = vectors.kdf;
const roots: Record<string, string> = {
  masterKey: kdf.masterKey,
  phraseEntropy: kdf.phraseEntropy,
  prfOutput: kdf.prfOutput,
};
for (const s of kdf.subkeys) roots[s.name] = s.key;

describe('crypto_kdf subkeys (crypto-spec.md §5)', () => {
  it.each(kdf.subkeys)('reproduces $context/$id ($name)', ({ parent, context, id, key }) => {
    const keyring = new Keyring();
    const parentKey = adoptKey(keyring, fromHex(roots[parent] ?? ''));
    const subkey = deriveSubkey(keyring, parentKey, context as KdfContext, id);
    expect(toHex(keyBytes(subkey))).toBe(key);
  });

  it('derives the four Master Key subkeys in one call', () => {
    const keyring = new Keyring();
    const sub = deriveMasterSubkeys(keyring, adoptKey(keyring, fromHex(kdf.masterKey)));
    const expected = Object.fromEntries(
      kdf.subkeys.filter((s) => s.parent === 'masterKey').map((s) => [s.name, s.key]),
    );
    expect({
      vaultKeyWrap: toHex(keyBytes(sub.vaultKeyWrap)),
      versionId: toHex(keyBytes(sub.versionId)),
      readmission: toHex(keyBytes(sub.readmission)),
      localConfig: toHex(keyBytes(sub.localConfig)),
    }).toEqual(expected);
    expect(keyring.size).toBe(5);
  });

  it('gives a different key for another ID or context', () => {
    const keyring = new Keyring();
    const parent = adoptKey(keyring, fromHex(kdf.masterKey));
    const a = toHex(keyBytes(deriveSubkey(keyring, parent, KdfContext.master, 1)));
    expect(toHex(keyBytes(deriveSubkey(keyring, parent, KdfContext.master, 5)))).not.toBe(a);
    expect(toHex(keyBytes(deriveSubkey(keyring, parent, KdfContext.prf, 1)))).not.toBe(a);
  });
});

describe('isMasterKeyOf (D57, D182)', () => {
  it('recognizes the Master Key of the subkeys, and no other, wiping what it derives', () => {
    const keyring = new Keyring();
    const masterKey = adoptKey(keyring, fromHex(kdf.masterKey));
    const subkeys = deriveMasterSubkeys(keyring, masterKey);
    const same = adoptKey(keyring, fromHex(kdf.masterKey));
    const size = keyring.size;
    expect(isMasterKeyOf(same, subkeys)).toBe(true);
    expect(isMasterKeyOf(generateKey(keyring), subkeys)).toBe(false);
    // Only the key generated above was added: every derived subkey is gone.
    expect(keyring.size).toBe(size + 1);
  });
});
