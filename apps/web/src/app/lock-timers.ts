// The two locks while unlocked (overview §7, D54, D88, D151): after `autoLockMinutes` without user
// activity, and after the app has been hidden for `hiddenLockSeconds` (0: at once). They run
// independently; neither can be turned off.

import { type Preferences } from '@blindvault/vault';

export class LockTimers {
  readonly #lock: () => void;
  #preferences: Preferences | undefined;
  #idle: ReturnType<typeof setTimeout> | undefined;
  #hidden: ReturnType<typeof setTimeout> | undefined;

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

  /** User input: restarts the inactivity timer. */
  activity(): void {
    const p = this.#preferences;
    if (!p) return;
    clearTimeout(this.#idle);
    this.#idle = setTimeout(() => {
      this.#fire();
    }, p.autoLockMinutes * 60_000);
  }

  /** `visibilitychange`: hidden starts the hidden-app timer, visible clears it. */
  visibility(hidden: boolean): void {
    const p = this.#preferences;
    if (!p) return;
    clearTimeout(this.#hidden);
    this.#hidden = undefined;
    if (!hidden) return;
    if (p.hiddenLockSeconds === 0) {
      this.#fire();
      return;
    }
    this.#hidden = setTimeout(() => {
      this.#fire();
    }, p.hiddenLockSeconds * 1000);
  }

  /** The vault locked for any reason: both timers stop. */
  stop(): void {
    clearTimeout(this.#idle);
    clearTimeout(this.#hidden);
    this.#idle = undefined;
    this.#hidden = undefined;
    this.#preferences = undefined;
  }

  #fire(): void {
    this.stop();
    this.#lock();
  }
}
