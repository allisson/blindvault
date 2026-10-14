// The storage state the UI shows (overview §7, §13.2, D55, D119, D196): whether the browser keeps
// this origin's storage, how much of the quota is used, and the warnings that follow from them.

import { type StorageStatus, requestPersistence, storageStatus } from '@blindvault/storage';

/** Storage is nearly full from this share of the quota: a chosen value, not a measured one. */
export const NEARLY_FULL = 0.8;

/** Browsers that name Safari in their user agent without being Safari. */
const NOT_SAFARI = /Chrome|Chromium|Edg|CriOS|FxiOS|Firefox/;

/** Safari, by its user agent: D55 needs the browser, and §13.1 forbids this only for the layout. */
export function isSafari(userAgent: string): boolean {
  return userAgent.includes('Safari/') && !NOT_SAFARI.test(userAgent);
}

/** A plain browser tab, not the installed app (Home Screen on iOS, Dock on macOS). */
export function plainTab(display: {
  readonly standaloneDisplay: boolean;
  readonly navigatorStandalone: unknown;
}): boolean {
  return !display.standaloneDisplay && display.navigatorStandalone !== true;
}

/** Safari in a plain tab, in this window. */
export function safariTab(): boolean {
  return (
    isSafari(navigator.userAgent) &&
    plainTab({
      standaloneDisplay: matchMedia('(display-mode: standalone)').matches,
      navigatorStandalone: (navigator as { standalone?: unknown }).standalone,
    })
  );
}

export function nearlyFull(usage: number | null, quota: number | null): boolean {
  return usage !== null && quota !== null && quota > 0 && usage / quota >= NEARLY_FULL;
}

export type StorageWarning = 'safari-tab' | 'not-kept' | 'nearly-full';

export interface WarningInput {
  readonly safariTab: boolean;
  readonly persisted: boolean | null;
  /** Whether this is the only device (D119); `undefined` while the vault is locked. */
  readonly onlyDevice: boolean | undefined;
  readonly usage: number | null;
  readonly quota: number | null;
}

/** Every warning that applies, the most serious first. */
export function storageWarnings(input: WarningInput): StorageWarning[] {
  const warnings: StorageWarning[] = [];
  if (input.safariTab) warnings.push('safari-tab');
  if (input.persisted === false && input.onlyDevice === true) warnings.push('not-kept');
  if (nearlyFull(input.usage, input.quota)) warnings.push('nearly-full');
  return warnings;
}

/** A browser with no storage manager: every answer unknown, every request refused. */
const NONE = {} as StorageManager;

/**
 * The last storage status read, for the UI to subscribe to. Read at unlock, on every return to
 * visible and after each persistence request, never by polling (D196).
 */
export class StorageMonitor {
  readonly #storage: StorageManager;
  #state: StorageStatus | undefined;
  #reads = 0;
  readonly #listeners = new Set<() => void>();

  constructor(storage: StorageManager | undefined) {
    this.#storage = storage ?? NONE;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getState = (): StorageStatus | undefined => this.#state;

  async refresh(): Promise<void> {
    const read = ++this.#reads;
    const state = await storageStatus(this.#storage);
    // An older read that answers last does not replace a newer one.
    if (read !== this.#reads) return;
    this.#state = state;
    for (const l of this.#listeners) l();
  }

  /** Asks the browser to keep the storage, on the user's click only (D196), then reads again. */
  async keep(): Promise<boolean> {
    const kept = await requestPersistence(this.#storage);
    await this.refresh();
    return kept;
  }
}
