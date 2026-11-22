// What differs between the web app, the browser extension and the Android app (extension.md §2,
// android.md §2, D267, D290). The build picks one implementation (`index.ts`); the rest of the app
// reads it and never asks where it runs.

// Types only: `app/clipboard` reads the platform when it loads.
import type { ClipboardPort } from '../app/clipboard';
import type { UpdateMonitor } from '../app/updates';

/** What starts and restarts the locks while unlocked (overview §7, D54, D151, D284). */
export interface LockSignals {
  /** Whether the app counts as hidden now: the hidden-app lock runs while it is. */
  hidden(): boolean;
  /** Calls `listener` on every change of `hidden()`; returns the unsubscribe. */
  onHidden(listener: (hidden: boolean) => void): () => void;
  /** Calls `listener` on user activity, which restarts the auto-lock; returns the unsubscribe. */
  onActivity(listener: () => void): () => void;
  /** Calls `listener` when the operating system locks, which locks the vault at once. */
  onSystemLock(listener: () => void): () => void;
}

/** What the update flow needs of the app, to apply an update without losing anything (D152). */
export interface UpdateHost {
  /** Whether the vault is locked or absent, with no operation in progress. */
  idle(): boolean;
  /** Calls `listener` on every change that may make `idle()` true; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

/** Saving a file where the page cannot download a `blob:` link (android.md §6.2). */
export interface FilePort {
  /** Hands `file` to the user as `name`: `cancelled` when the user declined, or another save ran. */
  save(file: Blob, name: string): Promise<'saved' | 'cancelled'>;
  /** The vault locked: aborts the save in progress, if any. */
  lock(): void;
}

export interface Platform {
  readonly kind: 'web' | 'extension' | 'android';
  /** Writes the clipboard: a copy, and its clear after the set time or on lock (D54, §6.3). */
  readonly clipboard: ClipboardPort;
  readonly lockSignals: LockSignals;
  /** Absent where an `<a download>` saves the file: the web and the extension. */
  readonly files?: FilePort;
  /**
   * Starts the update flow: on the web the service worker's, which the monitor follows (D190,
   * D191); in the extension the deferred reload of extension.md §8.1, applied once `host` is idle.
   */
  startUpdates(monitor: UpdateMonitor, host: UpdateHost): void;
}
