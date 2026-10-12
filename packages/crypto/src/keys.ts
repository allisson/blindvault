import { EncodingError, KeyWipedError } from './errors';
import { lib, randomBytes } from './sodium';

export const KEY_LENGTH = 32;

// Key bytes live only in this map, keyed by an opaque handle, so a handle that reaches a log,
// JSON.stringify or a debugger shows nothing (CRYPTO-INV-005). Only this package reads them.
const material = new WeakMap<SymmetricKey, Uint8Array>();

/** An opaque handle to a 32-byte symmetric key held by a keyring. */
export class SymmetricKey {
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
 * Holds every key of one unlocked session. `wipeAll()` zeroes them all with `sodium_memzero`
 * (best effort in JavaScript, CRYPTO-INV-010); afterwards every use of those keys, and every new
 * key, throws `KeyWipedError`.
 */
export class Keyring {
  readonly #keys = new Set<SymmetricKey>();
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
    if (this.#wiped) {
      lib().memzero(bytes);
      throw new KeyWipedError();
    }
    if (bytes.length !== KEY_LENGTH) {
      lib().memzero(bytes);
      throw new EncodingError('a key is 32 bytes');
    }
    const key = SymmetricKey.create();
    material.set(key, bytes);
    this.#keys.add(key);
    return key;
  }

  /** Wipes one key before the session ends, such as a record key once its record is written. */
  release(key: SymmetricKey): void {
    if (!this.#keys.delete(key)) return;
    wipe(key);
  }

  wipeAll(): void {
    for (const key of this.#keys) wipe(key);
    this.#keys.clear();
    this.#wiped = true;
  }
}

function wipe(key: SymmetricKey): void {
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
  const bytes = material.get(key);
  if (!bytes) throw new KeyWipedError();
  return bytes;
}
