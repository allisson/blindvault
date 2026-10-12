// Device identity: an X25519 key pair, the device's Noise static key (§7, D19, D67).

import { EncodingError } from './errors';
import { deviceId } from './ids';
import { KEY_LENGTH, type Keyring, type PrivateKey } from './keys';
import { lib } from './sodium';

export interface DeviceIdentity {
  readonly publicKey: Uint8Array;
  readonly privateKey: PrivateKey;
  /** `BLAKE2b-128(publicKey)`, the `recordId` of this device's Device record. */
  readonly deviceId: Uint8Array;
}

/** A new random identity; the private key lives only in `keyring`. */
export function generateDeviceIdentity(keyring: Keyring): DeviceIdentity {
  const pair = lib().crypto_box_keypair();
  return {
    publicKey: pair.publicKey,
    privateKey: keyring.adoptPrivate(pair.privateKey),
    deviceId: deviceId(pair.publicKey),
  };
}

/**
 * Loads an identity read from the encrypted part of Local Config. `privateKey` is owned by the
 * keyring from now on. A public key that is not the private key's is rejected.
 */
export function loadDeviceIdentity(
  keyring: Keyring,
  publicKey: Uint8Array,
  privateKey: Uint8Array,
): DeviceIdentity {
  if (publicKey.length !== KEY_LENGTH || privateKey.length !== KEY_LENGTH) {
    lib().memzero(privateKey);
    throw new EncodingError('an X25519 key is 32 bytes');
  }
  const derived = lib().crypto_scalarmult_base(privateKey);
  if (!lib().memcmp(derived, publicKey)) {
    lib().memzero(privateKey);
    throw new EncodingError('public key does not match the private key');
  }
  return {
    publicKey: publicKey.slice(),
    privateKey: keyring.adoptPrivate(privateKey),
    deviceId: deviceId(publicKey),
  };
}
