// What differs between the web app and the browser extension (extension.md §2, D267). The build picks
// one implementation (`index.ts`); the rest of the app reads it and never asks where it runs.

import { type ClipboardPort } from '../app/clipboard';
import { type UpdateMonitor } from '../app/updates';

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

export interface Platform {
  readonly kind: 'web' | 'extension';
  /** Writes the clipboard: a copy, and its clear after the set time or on lock (D54, §6.3). */
  readonly clipboard: ClipboardPort;
  readonly lockSignals: LockSignals;
  /**
   * Starts the update flow: on the web the service worker's, which the monitor follows (D190,
   * D191); in the extension the deferred reload of extension.md §8.1, applied once `host` is idle.
   */
  startUpdates(monitor: UpdateMonitor, host: UpdateHost): void;
}
