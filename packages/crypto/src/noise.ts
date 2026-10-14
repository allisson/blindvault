// The Noise handshakes of overview §8.2 and crypto-spec.md §13, over the state machine copied from
// noise-protocol (./noise, D157, D200). This file holds the device's static key, the size limits,
// the wiping and the errors; the handshake logic is the copy's. `packages/sync` runs the messages
// over the transport.

import { CryptoError, DecryptionError, EncodingError, KeyWipedError } from './errors';
import type { DeviceIdentity } from './identity';
import { privateKeyBytes } from './keys';
import { type HandshakeState, type KeyPair, type Split } from './noise/handshake-state';
import { type Noise, bindNoise } from './noise/index';
import { lib } from './sodium';

/** The longest Noise message, handshake or transport, tag included. */
export const NOISE_MAX_MESSAGE_LENGTH = 65_535;
export const NOISE_TAG_LENGTH = 16;
/** The longest plaintext of one transport message: 65,519 bytes. */
export const NOISE_MAX_PLAINTEXT_LENGTH = NOISE_MAX_MESSAGE_LENGTH - NOISE_TAG_LENGTH;
export const HANDSHAKE_HASH_LENGTH = 64;

const STATIC_KEY_LENGTH = 32;
// The most a handshake message adds to its payload: e (32), encrypted s (48) and the tag (16).
const HANDSHAKE_OVERHEAD = 96;
/** The longest payload a handshake message may carry here, so every message fits in 65,535 bytes. */
export const NOISE_MAX_HANDSHAKE_PAYLOAD_LENGTH = NOISE_MAX_MESSAGE_LENGTH - HANDSHAKE_OVERHEAD;
const EMPTY = new Uint8Array(0);

/** The handshake failed, or was used after it failed or finished. Fixed message, no detail. */
export class NoiseError extends CryptoError {
  override name = 'NoiseError';
  constructor() {
    super('noise handshake failed');
  }
}

export type NoisePattern = 'XX' | 'KK' | 'K';

/** What a finished handshake yields. */
export interface NoiseResult {
  /** The final handshake hash `h`, 64 bytes. */
  readonly handshakeHash: Uint8Array;
  /** The peer's static public key, as authenticated by the handshake. */
  readonly remoteStaticKey: Uint8Array;
  readonly transport: NoiseTransport;
}

let defaultNoise: Noise | undefined;

/**
 * One side of a handshake. `writeMessage` and `readMessage` follow the pattern's order; after the
 * last message `result` is set and the handshake state is wiped. Any failure wipes the state and
 * throws `NoiseError`, and every later call throws it too.
 */
export class NoiseHandshake {
  readonly #noise: Noise;
  #state: HandshakeState | null;
  #result: NoiseResult | null = null;

  /** @internal Use `startNoiseXX`. */
  constructor(
    noise: Noise,
    pattern: NoisePattern,
    initiator: boolean,
    prologue: Uint8Array,
    s: KeyPair,
    rs: Uint8Array | null,
  ) {
    this.#noise = noise;
    try {
      this.#state = noise.handshake.initialize(pattern, initiator, prologue, s, null, rs);
    } catch {
      throw new NoiseError();
    }
  }

  /** Set once the last handshake message is written or read. */
  get result(): NoiseResult | null {
    return this.#result;
  }

  /** The next handshake message, carrying `payload`. */
  writeMessage(payload: Uint8Array = EMPTY): Uint8Array {
    const state = this.#live();
    try {
      if (payload.length > NOISE_MAX_HANDSHAKE_PAYLOAD_LENGTH) throw new NoiseError();
      const buffer = new Uint8Array(payload.length + HANDSHAKE_OVERHEAD);
      const split = this.#noise.handshake.writeMessage(state, payload, buffer);
      const message = buffer.slice(0, this.#noise.handshake.writeMessage.bytes);
      if (split) this.#finish(state, split);
      return message;
    } catch {
      this.destroy();
      throw new NoiseError();
    }
  }

  /** Reads the peer's next handshake message and returns its payload. */
  readMessage(message: Uint8Array): Uint8Array {
    const state = this.#live();
    try {
      if (message.length > NOISE_MAX_MESSAGE_LENGTH) throw new NoiseError();
      const buffer = new Uint8Array(message.length);
      const split = this.#noise.handshake.readMessage(state, message, buffer);
      const payload = buffer.slice(0, this.#noise.handshake.readMessage.bytes);
      lib().memzero(buffer);
      if (split) this.#finish(state, split);
      return payload;
    } catch {
      this.destroy();
      throw new NoiseError();
    }
  }

  /** Wipes the handshake state, and the transport keys if the handshake had not finished. */
  destroy(): void {
    if (this.#state) this.#noise.handshake.destroy(this.#state);
    this.#state = null;
  }

  #live(): HandshakeState {
    if (!this.#state || this.#result) throw new NoiseError();
    return this.#state;
  }

  #finish(state: HandshakeState, split: Split): void {
    const handshakeHash = new Uint8Array(HANDSHAKE_HASH_LENGTH);
    try {
      if (!state.symmetricState || !state.rs) throw new NoiseError();
      this.#noise.symmetricState.getHandshakeHash(state.symmetricState, handshakeHash);
      const remoteStaticKey = state.rs.slice();
      this.#result = {
        handshakeHash,
        remoteStaticKey,
        transport: new NoiseTransport(this.#noise, split),
      };
    } catch (error) {
      lib().memzero(split.tx);
      lib().memzero(split.rx);
      throw error;
    } finally {
      this.destroy();
    }
  }
}

/**
 * The two CipherStates a handshake splits into. `encrypt` and `decrypt` handle one transport
 * message each, in order. A failed decryption wipes both keys, as `wipe()` does; any use after
 * that throws `KeyWipedError`.
 */
export class NoiseTransport {
  readonly #noise: Noise;
  readonly #tx: Uint8Array;
  readonly #rx: Uint8Array;
  #wiped = false;

  /** @internal Made by `NoiseHandshake`. */
  constructor(noise: Noise, split: Split) {
    this.#noise = noise;
    this.#tx = split.tx;
    this.#rx = split.rx;
  }

  get wiped(): boolean {
    return this.#wiped;
  }

  encrypt(plaintext: Uint8Array): Uint8Array {
    if (this.#wiped) throw new KeyWipedError();
    if (plaintext.length > NOISE_MAX_PLAINTEXT_LENGTH) {
      throw new EncodingError('a Noise transport message is at most 65,535 bytes');
    }
    const out = new Uint8Array(plaintext.length + NOISE_TAG_LENGTH);
    try {
      this.#noise.cipherState.encryptWithAd(this.#tx, out, EMPTY, plaintext);
    } catch {
      this.wipe();
      throw new KeyWipedError();
    }
    return out;
  }

  decrypt(ciphertext: Uint8Array): Uint8Array {
    if (this.#wiped) throw new KeyWipedError();
    try {
      if (ciphertext.length < NOISE_TAG_LENGTH || ciphertext.length > NOISE_MAX_MESSAGE_LENGTH) {
        throw new DecryptionError();
      }
      const out = new Uint8Array(ciphertext.length - NOISE_TAG_LENGTH);
      this.#noise.cipherState.decryptWithAd(this.#rx, out, EMPTY, ciphertext);
      return out;
    } catch {
      this.wipe();
      throw new DecryptionError();
    }
  }

  wipe(): void {
    lib().memzero(this.#tx);
    lib().memzero(this.#rx);
    this.#wiped = true;
  }
}

/** @internal The handshake of any copied pattern, for the vectors; the app uses `startNoiseXX`. */
export function startNoise(
  options: {
    pattern: NoisePattern;
    initiator: boolean;
    prologue: Uint8Array;
    staticKey: KeyPair;
    remoteStaticKey?: Uint8Array;
  },
  noise: Noise = (defaultNoise ??= bindNoise()),
): NoiseHandshake {
  const { publicKey, secretKey } = options.staticKey;
  if (publicKey.length !== STATIC_KEY_LENGTH || secretKey.length !== STATIC_KEY_LENGTH) {
    throw new EncodingError('an X25519 key is 32 bytes');
  }
  return new NoiseHandshake(
    noise,
    options.pattern,
    options.initiator,
    options.prologue,
    options.staticKey,
    options.remoteStaticKey ?? null,
  );
}

/**
 * `Noise_XX_25519_ChaChaPoly_BLAKE2b` with the device identity as the static key. The handshake
 * copies the private key into its own state and wipes the copy when it finishes or fails.
 */
export function startNoiseXX(options: {
  initiator: boolean;
  prologue: Uint8Array;
  identity: DeviceIdentity;
}): NoiseHandshake {
  return startNoise({
    pattern: 'XX',
    initiator: options.initiator,
    prologue: options.prologue,
    staticKey: {
      publicKey: options.identity.publicKey,
      secretKey: privateKeyBytes(options.identity.privateKey),
    },
  });
}
