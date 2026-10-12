// Copying a secret or a TOTP code (D54, D127, D151): only on explicit action, then a try to clear
// the clipboard after `clipboardClearSeconds`, while the app has focus, since browsers refuse a
// clipboard write from a page in the background. A timeout that passes in the background clears
// on the next focus; a lock clears at once, the same way. Clearing is not guaranteed: a clear the
// browser refuses is dropped, and the OS clipboard history is out of reach (overview §16).

export interface ClipboardPort {
  write(text: string): Promise<void>;
  hasFocus(): boolean;
  /** Calls `listener` on focus; returns the unsubscribe. */
  onFocus(listener: () => void): () => void;
}

export const CLEAR_SECONDS = { min: 10, max: 120 } as const;

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
    if (
      !Number.isSafeInteger(seconds) ||
      seconds < CLEAR_SECONDS.min ||
      seconds > CLEAR_SECONDS.max
    ) {
      throw new RangeError('clipboard clear timeout out of range');
    }
    this.#cancel();
    await this.#port.write(text);
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

/** The browser's clipboard; looked up on use, so importing this module needs no DOM. */
export const browserClipboard: ClipboardPort = {
  write: (text) => navigator.clipboard.writeText(text),
  hasFocus: () => document.hasFocus(),
  onFocus: (listener) => {
    window.addEventListener('focus', listener);
    return () => {
      window.removeEventListener('focus', listener);
    };
  },
};

export const clipboard = new ClipboardGuard(browserClipboard);
