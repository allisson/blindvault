import { EncodingError, KeyWipedError } from './errors';
import { lib, randomBytes } from './sodium';

export const KEY_LENGTH = 32;

// Key bytes live only in this map, keyed by an opaque handle, so a handle that reaches a log,
// JSON.stringify or a debugger shows nothing (CRYPTO-INV-005). Only this package reads them.
const material = new WeakMap<SymmetricKey | PrivateKey, Uint8Array>();

/** An opaque handle to a 32-byte symmetric key held by a keyring. */
export class SymmetricKey {
  // Type-only brand: keeps the two handle classes from being structurally interchangeable.
  declare private readonly brand: 'SymmetricKey';

  private constructor() {
    Object.freeze(this);
  }

  /** @internal Use `generateKey` or `adoptKey`. */
  static create(): SymmetricKey {
    return new SymmetricKey();
  }

  toJSON(): string {
    return '[SymmetricKey]';
  }

  toString(): string {
    return '[SymmetricKey]';
  }
}

/**
 * An opaque handle to a 32-byte X25519 private key held by a keyring: the device identity or the
 * recovery keyslot key pair. A distinct type, so it can never be passed where a symmetric key is
 * expected.
 */
export class PrivateKey {
  declare private readonly brand: 'PrivateKey';

  private constructor() {
    Object.freeze(this);
  }

  /** @internal Use `generateDeviceIdentity` or `deriveRecoveryKeys`. */
  static create(): PrivateKey {
    return new PrivateKey();
  }

  toJSON(): string {
    return '[PrivateKey]';
  }

  toString(): string {
    return '[PrivateKey]';
  }
}

/**
 * Holds every key of one unlocked session. `wipeAll()` zeroes them all with `sodium_memzero`
 * (best effort in JavaScript, CRYPTO-INV-010); afterwards every use of those keys, and every new
 * key, throws `KeyWipedError`.
 */
export class Keyring {
  readonly #keys = new Set<SymmetricKey | PrivateKey>();
  #wiped = false;

  get wiped(): boolean {
    return this.#wiped;
  }

  /** Number of live keys, for tests and diagnostics. */
  get size(): number {
    return this.#keys.size;
  }

  /** @internal Takes ownership of `bytes`: the keyring wipes them, so the caller keeps no copy. */
  adopt(bytes: Uint8Array): SymmetricKey {
    return this.#register(SymmetricKey.create(), bytes);
  }

  /** @internal Same as `adopt`, for an X25519 private key. */
  adoptPrivate(bytes: Uint8Array): PrivateKey {
    return this.#register(PrivateKey.create(), bytes);
  }

  #register<K extends SymmetricKey | PrivateKey>(key: K, bytes: Uint8Array): K {
    if (this.#wiped) {
      lib().memzero(bytes);
      throw new KeyWipedError();
    }
    if (bytes.length !== KEY_LENGTH) {
      lib().memzero(bytes);
      throw new EncodingError('a key is 32 bytes');
    }
    material.set(key, bytes);
    this.#keys.add(key);
    return key;
  }

  /** Wipes one key before the session ends, such as a record key once its record is written. */
  release(key: SymmetricKey | PrivateKey): void {
    if (!this.#keys.delete(key)) return;
    wipe(key);
  }

  wipeAll(): void {
    for (const key of this.#keys) wipe(key);
    this.#keys.clear();
    this.#wiped = true;
  }
}

function wipe(key: SymmetricKey | PrivateKey): void {
  const bytes = material.get(key);
  if (bytes) lib().memzero(bytes);
  material.delete(key);
}

/** A new random key from the CSPRNG (Master Key, Vault Key, record keys). */
export function generateKey(keyring: Keyring): SymmetricKey {
  return keyring.adopt(randomBytes(KEY_LENGTH));
}

/** @internal Wraps raw bytes in a handle; `bytes` is owned by the keyring from now on. */
export function adoptKey(keyring: Keyring, bytes: Uint8Array): SymmetricKey {
  return keyring.adopt(bytes);
}

/** @internal The key's bytes, for libsodium calls inside this package only. */
export function keyBytes(key: SymmetricKey): Uint8Array {
  // The brand is type-only: a cast or untyped caller could still pass a PrivateKey.
  if (!(key instanceof SymmetricKey)) throw new EncodingError('not a symmetric key');
  const bytes = material.get(key);
  if (!bytes) throw new KeyWipedError();
  return bytes;
}

/** @internal The private key's bytes, for libsodium calls inside this package only. */
export function privateKeyBytes(key: PrivateKey): Uint8Array {
  if (!(key instanceof PrivateKey)) throw new EncodingError('not a private key');
  const bytes = material.get(key);
  if (!bytes) throw new KeyWipedError();
  return bytes;
}

/**
 * Whether two keys hold the same bytes, compared in constant time with `sodium_memcmp`: an
 * immutable Vault Key record received again (D42) or a backup's Master Key subkey (D57).
 */
export function sameKey(a: SymmetricKey, b: SymmetricKey): boolean {
  return lib().memcmp(keyBytes(a), keyBytes(b));
}
