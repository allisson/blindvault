// Hybrid logical clock (overview §9.2, D19, D62, D73, D76, D85, D109, D163; CRYPTO-INV-020).

import { type Hlc, ID_LENGTH } from '@blindvault/crypto';

import { ContentInvalidError, HlcReadOnlyError } from './errors';
import { compareBytes } from './text';

/** The future-clock bound: 24 hours ahead of this device's physical clock (D76). */
export const FUTURE_CLOCK_BOUND_MS = 24 * 60 * 60 * 1000;
const MAX_COUNTER = 2 ** 32 - 1;

/** Lexicographic order: `physicalMs`, then `counter`, then `deviceId` bytewise. Never 0 for two devices. */
export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.physicalMs !== b.physicalMs) return a.physicalMs < b.physicalMs ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  return Math.sign(compareBytes(a.deviceId, b.deviceId));
}

function maxHlc(a: Hlc, b: Hlc): Hlc {
  return compareHlc(a, b) >= 0 ? a : b;
}

/** Throws unless `hlc` is in range: `physicalMs` ≤ 2^53 − 1, `counter` ≤ 2^32 − 1, 16-byte `deviceId`. */
export function checkHlc(hlc: Hlc): void {
  if (
    !Number.isSafeInteger(hlc.physicalMs) ||
    hlc.physicalMs < 0 ||
    !Number.isInteger(hlc.counter) ||
    hlc.counter < 0 ||
    hlc.counter > MAX_COUNTER ||
    !(hlc.deviceId instanceof Uint8Array) ||
    hlc.deviceId.length !== ID_LENGTH
  ) {
    throw new ContentInvalidError('hlc');
  }
}

function copy(hlc: Hlc): Hlc {
  return { physicalMs: hlc.physicalMs, counter: hlc.counter, deviceId: hlc.deviceId.slice() };
}

/**
 * The device's HLC. Its state is the greatest HLC issued or accepted (D109), persisted by the
 * caller in the same storage transaction as each write or accepted record (D62).
 */
export class HlcClock {
  #state: Hlc;
  readonly #deviceId: Uint8Array;
  readonly #now: () => number;

  private constructor(deviceId: Uint8Array, state: Hlc, now: () => number) {
    this.#deviceId = deviceId.slice();
    this.#state = copy(state);
    this.#now = now;
  }

  /** A new device: its state starts at `(now, 0, deviceId)`; the first HLC issued is above it. */
  static create(deviceId: Uint8Array, now: () => number): HlcClock {
    const state = { physicalMs: Math.floor(now()), counter: 0, deviceId };
    checkHlc(state);
    return new HlcClock(deviceId, state, now);
  }

  /**
   * Startup (D62): resumes from the greater of the stored state and the greatest `hlc` held.
   * A held `hlc` beyond the bound does not advance the state (D109); a stored state beyond the cap
   * is kept, and makes the vault read-only (D73).
   */
  static resume(
    deviceId: Uint8Array,
    stored: Hlc,
    held: Iterable<Hlc>,
    now: () => number,
  ): HlcClock {
    checkHlc(stored);
    const clock = new HlcClock(deviceId, stored, now);
    for (const hlc of held) clock.receive(hlc);
    return clock;
  }

  get state(): Hlc {
    return copy(this.#state);
  }

  #cap(): number {
    return Math.floor(this.#now()) + FUTURE_CLOCK_BOUND_MS;
  }

  /** Whether `hlc` is beyond the future-clock bound of this device's clock. */
  beyondBound(hlc: Hlc): boolean {
    return hlc.physicalMs > this.#cap();
  }

  /** Whether a write can take an HLC now: false while the state is beyond the cap (D73). */
  get writable(): boolean {
    return !this.beyondBound(this.#state);
  }

  /** The physical time (Unix ms) at which writing resumes, or `null` when writable now. */
  get writableAt(): number | null {
    return this.writable ? null : this.#state.physicalMs - FUTURE_CLOCK_BOUND_MS;
  }

  /**
   * A new HLC for a write, greater than the state and than the `hlc` of the record it replaces
   * (D109). Throws `HlcReadOnlyError` instead of issuing one beyond the cap (CRYPTO-INV-020).
   */
  issue(replaces?: Hlc): Hlc {
    if (replaces) checkHlc(replaces);
    const base = replaces ? maxHlc(this.#state, replaces) : this.#state;
    const physical = Math.floor(this.#now());
    let next: Hlc;
    if (physical > base.physicalMs) {
      next = { physicalMs: physical, counter: 0, deviceId: this.#deviceId };
    } else if (base.counter < MAX_COUNTER) {
      next = { physicalMs: base.physicalMs, counter: base.counter + 1, deviceId: this.#deviceId };
    } else {
      next = { physicalMs: base.physicalMs + 1, counter: 0, deviceId: this.#deviceId };
    }
    if (this.beyondBound(next) || !Number.isSafeInteger(next.physicalMs)) {
      throw new HlcReadOnlyError();
    }
    this.#state = copy(next);
    return copy(next);
  }

  /**
   * The HLC of a retirement (D85): the state with its counter incremented, even beyond the cap, so
   * it stays monotonic. The only HLC issued beyond the cap.
   */
  issueRetirement(): Hlc {
    const { physicalMs, counter } = this.#state;
    const next =
      counter < MAX_COUNTER
        ? { physicalMs, counter: counter + 1, deviceId: this.#deviceId }
        : { physicalMs: physicalMs + 1, counter: 0, deviceId: this.#deviceId };
    checkHlc(next);
    this.#state = copy(next);
    return copy(next);
  }

  /** Receive rule (D109): an accepted record's `hlc` advances the state, unless beyond the bound. */
  receive(hlc: Hlc): void {
    checkHlc(hlc);
    if (this.beyondBound(hlc)) return;
    this.#state = copy(maxHlc(this.#state, hlc));
  }
}
