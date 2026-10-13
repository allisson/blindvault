// The two locks while unlocked (overview §7, D54, D88, D151): after `autoLockMinutes` without user
// activity, and after the app has been hidden for `hiddenLockSeconds` (0: at once). They run
// independently; neither can be turned off. Only the inactivity timer pauses, while a Recovery Phrase
// is shown or confirmed (D104).

import { type Preferences } from '@blindvault/vault';

export class LockTimers {
  readonly #lock: () => void;
  #preferences: Preferences | undefined;
  #idle: ReturnType<typeof setTimeout> | undefined;
  #hidden: ReturnType<typeof setTimeout> | undefined;
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
    const p = this.#preferences;
    clearTimeout(this.#idle);
    this.#idle = undefined;
    if (!p || this.#paused) return;
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

  /** A Recovery Phrase is shown: the inactivity timer stops until `resume` (D104). */
  pause(): void {
    this.#paused = true;
    clearTimeout(this.#idle);
    this.#idle = undefined;
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
    this.#preferences = undefined;
  }

  #fire(): void {
    this.stop();
    this.#lock();
  }
}
