// The vault read-only because the device clock went back (overview §9.2, D73, D149, D221): when
// writing resumes, the ways out when that is more than the future-clock bound away, and a timer
// that tells the controller once the clock gets there.

import { FUTURE_CLOCK_BOUND_MS } from '@blindvault/vault';

import { type DeviceSource, devicesOf } from './devices';

export interface ClockNotice {
  /** When writing resumes (Unix ms). */
  readonly until: number;
  /** Writing resumes more than the future-clock bound later: the UI offers the ways out (D149). */
  readonly far: boolean;
  /** With `far`: another non-retired device exists, so this one can be paired again (D153). */
  readonly pairAgain: boolean;
}

interface ClockSource extends DeviceSource {
  readonly writableAt: number | null;
}

export function clockNoticeOf(session: ClockSource, now: number): ClockNotice | undefined {
  const until = session.writableAt;
  if (until === null) return undefined;
  const far = until - now > FUTURE_CLOCK_BOUND_MS;
  return { until, far, pairAgain: far && devicesOf(session).listed.some((d) => !d.own) };
}

/** The longest delay `setTimeout` takes; a later moment is reached in steps. */
export const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** Calls `reached` once the physical clock reaches the moment set, with no polling. */
export class WritableTimer {
  readonly #now: () => number;
  readonly #reached: () => void;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(now: () => number, reached: () => void) {
    this.#now = now;
    this.#reached = reached;
  }

  /** Replaces the moment waited for; `null` waits for nothing. */
  set(at: number | null): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (at === null) return;
    const wait = Math.min(Math.max(at - this.#now(), 0), MAX_TIMEOUT_MS);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (this.#now() >= at) this.#reached();
      else this.set(at);
    }, wait);
  }
}
