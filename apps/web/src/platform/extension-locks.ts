// The extension's lock signals and clipboard (extension.md §3.2, §6.3, D284, D286). The session host
// is a pinned tab, hidden whenever another tab shows, so the hidden-app lock counts the time the
// browser as a whole has no focus; the operating system's lock locks at once; activity is input in
// the session host or a message of the popup, never browsing. The clipboard's clear goes through the
// service worker, which writes without the focus.

// A type only: `app/clipboard` reads the platform when it loads.
import type { ClipboardPort } from '../app/clipboard';
import { nextId } from '../extension/rpc';
import { type LockSignals } from './platform';

interface Listened<T extends unknown[]> {
  addListener(listener: (...args: T) => void): void;
  removeListener(listener: (...args: T) => void): void;
}

/** The parts of `chrome.windows`, `chrome.idle` and `chrome.runtime` these use. */
export interface ExtensionApi {
  readonly windows: {
    readonly WINDOW_ID_NONE: number;
    readonly onFocusChanged: Listened<[windowId: number]>;
    getLastFocused(): Promise<{ readonly focused: boolean }>;
  };
  readonly idle: { readonly onStateChanged: Listened<[state: string]> };
  readonly runtime: { sendMessage(message: unknown): Promise<unknown> };
}

/** The extension's APIs; `undefined` outside an extension page (the tests, the dev server). */
export function extensionApi(): ExtensionApi | undefined {
  const chrome = (globalThis as { chrome?: Partial<ExtensionApi> }).chrome;
  return chrome?.windows && chrome.idle && chrome.runtime ? (chrome as ExtensionApi) : undefined;
}

export interface ExtensionLockSignals extends LockSignals {
  /** An interaction outside the page: a message of the popup, a fill (D284). */
  touch(): void;
}

/**
 * `api` is looked up on first use, so creating the signals needs no extension. `page` gives the
 * input in the session host itself.
 */
export function extensionLockSignals(
  api: () => ExtensionApi | undefined,
  page: Pick<LockSignals, 'onActivity'>,
): ExtensionLockSignals {
  // Until the browser says otherwise, the user who just opened the page has it focused.
  let unfocused = false;
  let watching = false;
  const hiddenListeners = new Set<(hidden: boolean) => void>();
  const activityListeners = new Set<() => void>();
  const set = (next: boolean): void => {
    if (next === unfocused) return;
    unfocused = next;
    for (const l of hiddenListeners) l(next);
  };
  const watch = (): void => {
    const a = api();
    if (watching || !a) return;
    watching = true;
    a.windows.onFocusChanged.addListener((windowId) => {
      set(windowId === a.windows.WINDOW_ID_NONE);
    });
    a.windows.getLastFocused().then(
      (w) => {
        set(!w.focused);
      },
      () => undefined,
    );
  };
  return {
    hidden: () => {
      watch();
      return unfocused;
    },
    onHidden: (listener) => {
      watch();
      hiddenListeners.add(listener);
      return () => {
        hiddenListeners.delete(listener);
      };
    },
    onActivity: (listener) => {
      activityListeners.add(listener);
      const stop = page.onActivity(listener);
      return () => {
        activityListeners.delete(listener);
        stop();
      };
    },
    onSystemLock: (listener) => {
      const a = api();
      if (!a) return () => undefined;
      const changed = (state: string): void => {
        if (state === 'locked') listener();
      };
      a.idle.onStateChanged.addListener(changed);
      return () => {
        a.idle.onStateChanged.removeListener(changed);
      };
    },
    touch: () => {
      for (const l of activityListeners) l();
    },
  };
}

/**
 * The session host copies with the focus, as a page does; the clear, timed by the session host, is
 * the service worker's (§6.3), so it needs no focus and never waits for one.
 */
export function extensionClipboard(
  api: () => ExtensionApi | undefined,
  write: (text: string) => Promise<void>,
): ClipboardPort {
  return {
    write: async (text) => {
      const a = api();
      if (text !== '' || !a) {
        await write(text);
        return;
      }
      await a.runtime.sendMessage({ v: 1, type: 'clipboard-clear', id: nextId() });
    },
    hasFocus: () => true,
    onFocus: () => () => undefined,
  };
}
