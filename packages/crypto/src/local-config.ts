// The encrypted part of Local Config (crypto-spec.md §12, D58, D67, D159). It holds the device
// identity, so it is sealed and opened here: the private key is read as bytes only in this package.

import { type Sealed, open, seal } from './aead';
import { type CborMap, type CborValue, decodeCbor, encodeCbor } from './cbor';
import { EncodingError } from './errors';
import { type DeviceIdentity, loadDeviceIdentity } from './identity';
import { type Keyring, type SymmetricKey, privateKeyBytes } from './keys';
import { pad, unpad } from './pad';
import { lib } from './sodium';

const IDENTITY = 'deviceIdentity';

/**
 * Seals `content`, the encrypted part without its device identity, with `identity` added as
 * `deviceIdentity` (`record-content.md` §9). The caller validates `content` first.
 */
export function sealLocalConfigPart(
  key: SymmetricKey,
  aad: Uint8Array,
  content: CborMap,
  identity: DeviceIdentity,
): Sealed {
  if (content.has(IDENTITY)) throw new EncodingError('the device identity is added here');
  const map: CborMap = new Map(content);
  map.set(
    IDENTITY,
    new Map<CborValue, CborValue>([
      ['publicKey', identity.publicKey],
      ['privateKey', privateKeyBytes(identity.privateKey)],
    ]),
  );
  const encoded = encodeCbor(map);
  const padded = pad(encoded);
  try {
    return seal(key, aad, padded);
  } finally {
    lib().memzero(encoded);
    lib().memzero(padded);
  }
}

/** A deep copy whose byte strings own their buffers, so the plaintext can be wiped. */
function detach(value: CborValue): CborValue {
  if (value instanceof Uint8Array) return value.slice();
  if (Array.isArray(value)) return value.map(detach);
  if (value instanceof Map) {
    return new Map<CborValue, CborValue>([...value].map(([k, v]) => [detach(k), detach(v)]));
  }
  return value;
}

/**
 * Opens the encrypted part. Returns its content without `deviceIdentity`, and the identity loaded
 * into `keyring`. A part that fails to open throws `DecryptionError`; a part whose padding,
 * encoding or identity is invalid throws `EncodingError`. The plaintext is wiped either way.
 */
export function openLocalConfigPart(
  keyring: Keyring,
  key: SymmetricKey,
  aad: Uint8Array,
  sealed: Sealed,
): { content: CborMap; identity: DeviceIdentity } {
  const plaintext = open(key, aad, sealed);
  let unpadded: Uint8Array | undefined;
  try {
    let value: CborValue;
    try {
      unpadded = unpad(plaintext);
      value = decodeCbor(unpadded);
    } catch {
      throw new EncodingError('invalid Local Config part');
    }
    if (!(value instanceof Map)) throw new EncodingError('invalid Local Config part');
    const ident = value.get(IDENTITY);
    if (!(ident instanceof Map) || ident.size !== 2) {
      throw new EncodingError('invalid device identity');
    }
    const publicKey = ident.get('publicKey');
    const privateKey = ident.get('privateKey');
    if (!(publicKey instanceof Uint8Array) || !(privateKey instanceof Uint8Array)) {
      throw new EncodingError('invalid device identity');
    }
    // Decoded byte strings are views of the plaintext: the keyring takes a copy of its own.
    const identity = loadDeviceIdentity(keyring, publicKey, privateKey.slice());
    const content = detach(value) as CborMap;
    content.delete(IDENTITY);
    return { content, identity };
  } finally {
    lib().memzero(plaintext);
    if (unpadded) lib().memzero(unpadded);
  }
}
