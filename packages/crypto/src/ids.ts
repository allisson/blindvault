// Derived identifiers (crypto-spec.md §4, D6, D19, D66).

import { EncodingError } from './errors';
import { type SymmetricKey, keyBytes } from './keys';
import { type Hlc, id, label, layout, u32, u64 } from './layout';
import { lib } from './sodium';

const ID_HASH_LENGTH = 16;
export const PUBLIC_KEY_LENGTH = 32;

/** `deviceId = BLAKE2b-128(static public key)`, unkeyed. */
export function deviceId(publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== PUBLIC_KEY_LENGTH) throw new EncodingError('a public key is 32 bytes');
  return lib().crypto_generichash(ID_HASH_LENGTH, publicKey, null);
}

/** The fixed `recordId` of the Vault Key record of `keyEpoch`. */
export function vaultKeyRecordId(keyEpoch: number): Uint8Array {
  return lib().crypto_generichash(
    ID_HASH_LENGTH,
    layout(label('bv.v1.recordid.vault-key'), u32(keyEpoch)),
    null,
  );
}

/** The fixed `recordId` of the vault's Recovery Envelope. */
export function recoveryEnvelopeRecordId(vaultId: Uint8Array): Uint8Array {
  return lib().crypto_generichash(
    ID_HASH_LENGTH,
    layout(label('bv.v1.recordid.recovery-envelope'), id(vaultId)),
    null,
  );
}

/** `versionId = BLAKE2b-128(key = K_versionId, layout(itemId, u64 physicalMs, u32 counter, deviceId))` */
export function versionId(versionIdKey: SymmetricKey, itemId: Uint8Array, hlc: Hlc): Uint8Array {
  return lib().crypto_generichash(
    ID_HASH_LENGTH,
    layout(id(itemId), u64(hlc.physicalMs), u32(hlc.counter), id(hlc.deviceId)),
    keyBytes(versionIdKey),
  );
}
