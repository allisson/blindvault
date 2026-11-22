// Copying a secret or a TOTP code (D54, D127, D151): only on explicit action, then a try to clear
// the clipboard after `clipboardClearSeconds`, while the app has focus, since browsers refuse a
// clipboard write from a page in the background. A timeout that passes in the background clears
// on the next focus; a lock clears at once, the same way. Clearing is not guaranteed: a clear the
// browser refuses is dropped, and the OS clipboard history is out of reach (overview §16).

import { platform } from '../platform';

export interface ClipboardPort {
  /**
   * Writes `text`; `''` clears. A copy carries the clear's time, for a platform whose clear does not
   * run in the page (android.md §6.1).
   */
  write(text: string, clearSeconds?: number): Promise<void>;
  hasFocus(): boolean;
  /** Calls `listener` on focus; returns the unsubscribe. */
  onFocus(listener: () => void): () => void;
}

export const CLEAR_SECONDS = { min: 10, max: 120 } as const;

function checkSeconds(seconds: number): void {
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < CLEAR_SECONDS.min ||
    seconds > CLEAR_SECONDS.max
  ) {
    throw new RangeError('clipboard clear timeout out of range');
  }
}

export class ClipboardGuard {
  readonly #port: ClipboardPort;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #waiting: (() => void) | undefined;
  #copied = false;

  constructor(port: ClipboardPort) {
    this.#port = port;
  }

  /** Writes `text` and schedules the clear; rejects when the browser refuses the write. */
  async copy(text: string, seconds: number): Promise<void> {
    checkSeconds(seconds);
    this.#cancel();
    await this.#port.write(text, seconds);
    this.copied(seconds);
  }

  /**
   * Another page wrote the clipboard, the extension's popup (extension.md §6.3): schedules the clear
   * as `copy` does.
   */
  copied(seconds: number): void {
    checkSeconds(seconds);
    this.#cancel();
    this.#copied = true;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#clearWhenFocused();
    }, seconds * 1000);
  }

  /** The vault locked: clear what was copied now, or on the next focus. */
  lock(): void {
    this.#cancel();
    this.#clearWhenFocused();
  }

  #clearWhenFocused(): void {
    if (!this.#copied) return;
    if (this.#port.hasFocus()) {
      this.#clear();
      return;
    }
    this.#waiting = this.#port.onFocus(() => {
      this.#cancel();
      this.#clear();
    });
  }

  #clear(): void {
    this.#copied = false;
    this.#port.write('').catch(() => undefined);
  }

  #cancel(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#waiting?.();
    this.#waiting = undefined;
  }
}

export const clipboard = new ClipboardGuard(platform.clipboard);
