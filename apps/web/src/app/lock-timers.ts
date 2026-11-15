// The two locks while unlocked (overview §7, D54, D88, D151): after `autoLockMinutes` without user
// activity, and after the app has been hidden for `hiddenLockSeconds` (0: at once). They run
// independently; neither can be turned off. Only the inactivity timer pauses, while a Recovery Phrase
// is shown or confirmed (D104). Each timer also keeps its deadline by the wall clock: a frozen page or
// a suspended device does not run timers, so an expired deadline locks at the next activity or
// visibility change, before either restarts (D263).

import { type Preferences } from '@blindvault/vault';

export class LockTimers {
  readonly #lock: () => void;
  #preferences: Preferences | undefined;
  #idle: ReturnType<typeof setTimeout> | undefined;
  #hidden: ReturnType<typeof setTimeout> | undefined;
  #idleAt: number | undefined;
  #hiddenAt: number | undefined;
  #paused = false;

  constructor(lock: () => void) {
    this.#lock = lock;
  }

  /** Starts both timers for an unlocked vault, or restarts them with new preferences. */
  start(preferences: Preferences, hidden: boolean): void {
    this.#preferences = preferences;
    this.activity();
    clearTimeout(this.#hidden);
    this.#hidden = undefined;
    if (hidden) this.visibility(true);
  }

  /** User input: restarts the inactivity timer, unless it is paused. */
  activity(): void {
    if (this.#expired()) return;
    const p = this.#preferences;
    clearTimeout(this.#idle);
    this.#idle = undefined;
    this.#idleAt = undefined;
    if (!p || this.#paused) return;
    this.#idleAt = Date.now() + p.autoLockMinutes * 60_000;
    this.#idle = setTimeout(() => {
      this.#fire();
    }, p.autoLockMinutes * 60_000);
  }

  /** `visibilitychange`: hidden starts the hidden-app timer, visible clears it. */
  visibility(hidden: boolean): void {
    const p = this.#preferences;
    if (!p || this.#expired()) return;
    clearTimeout(this.#hidden);
    this.#hidden = undefined;
    this.#hiddenAt = undefined;
    if (!hidden) return;
    if (p.hiddenLockSeconds === 0) {
      this.#fire();
      return;
    }
    this.#hiddenAt = Date.now() + p.hiddenLockSeconds * 1000;
    this.#hidden = setTimeout(() => {
      this.#fire();
    }, p.hiddenLockSeconds * 1000);
  }

  /** A Recovery Phrase is shown: the inactivity timer stops until `resume` (D104). */
  pause(): void {
    this.#paused = true;
    clearTimeout(this.#idle);
    this.#idle = undefined;
    this.#idleAt = undefined;
  }

  /** The phrase is gone: the inactivity timer starts again from its full time. */
  resume(): void {
    if (!this.#paused) return;
    this.#paused = false;
    this.activity();
  }

  /** The vault locked for any reason: both timers stop, and so does a pause. */
  stop(): void {
    this.#paused = false;
    clearTimeout(this.#idle);
    clearTimeout(this.#hidden);
    this.#idle = undefined;
    this.#hidden = undefined;
    this.#idleAt = undefined;
    this.#hiddenAt = undefined;
    this.#preferences = undefined;
  }

  /** Locks if a deadline passed while no timer ran (D263). */
  #expired(): boolean {
    const now = Date.now();
    const late =
      (this.#idleAt !== undefined && now >= this.#idleAt) ||
      (this.#hiddenAt !== undefined && now >= this.#hiddenAt);
    if (late) this.#fire();
    return late;
  }

  #fire(): void {
    this.stop();
    this.#lock();
  }
}
