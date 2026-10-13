// Subkeys with crypto_kdf (crypto-spec.md §5, D2, D16, D23, D75). A parent key is used only to
// derive the subkeys of its row, never directly as an encryption key.

import { KEY_LENGTH, Keyring, type SymmetricKey, keyBytes, sameKey } from './keys';
import { lib } from './sodium';

/** `crypto_kdf` contexts, 8 ASCII bytes each. A changed derivation takes a new context. */
export const KdfContext = {
  master: 'bvmaster',
  phrase: 'bvrphras',
  recoveryKek: 'bvrckek_',
  prf: 'bvprfkek',
} as const;

export type KdfContext = (typeof KdfContext)[keyof typeof KdfContext];

/** @internal One subkey of `parent` into `keyring`. */
export function deriveSubkey(
  keyring: Keyring,
  parent: SymmetricKey,
  context: KdfContext,
  subkeyId: number,
): SymmetricKey {
  return keyring.adopt(
    lib().crypto_kdf_derive_from_key(KEY_LENGTH, subkeyId, context, keyBytes(parent)),
  );
}

/** The four Master Key subkeys, one per purpose (D23, D29, D58). */
export interface MasterSubkeys {
  readonly vaultKeyWrap: SymmetricKey;
  readonly versionId: SymmetricKey;
  readonly readmission: SymmetricKey;
  readonly localConfig: SymmetricKey;
}

export function deriveMasterSubkeys(keyring: Keyring, masterKey: SymmetricKey): MasterSubkeys {
  return {
    vaultKeyWrap: deriveSubkey(keyring, masterKey, KdfContext.master, 1),
    versionId: deriveSubkey(keyring, masterKey, KdfContext.master, 2),
    readmission: deriveSubkey(keyring, masterKey, KdfContext.master, 3),
    localConfig: deriveSubkey(keyring, masterKey, KdfContext.master, 4),
  };
}

/**
 * Whether `masterKey` is the Master Key `subkeys` were derived from (D57, D182). A session holds no
 * Master Key, so its `K_vaultKeyWrap` is compared with the one `masterKey` derives, in constant
 * time, as Check Recovery Phrase does (D180). The subkeys it derives are wiped before returning.
 */
export function isMasterKeyOf(masterKey: SymmetricKey, subkeys: MasterSubkeys): boolean {
  const scratch = new Keyring();
  try {
    const candidate = deriveSubkey(scratch, masterKey, KdfContext.master, 1);
    return sameKey(candidate, subkeys.vaultKeyWrap);
  } finally {
    scratch.wipeAll();
  }
}
