// The extension's update, deferred while the vault is open (extension.md §8.1, D270, D285). A
// listener on `runtime.onUpdateAvailable` stops the browser from reloading the extension at once; the
// session host reloads it when the vault is locked, or at once when it already is. The extension's
// service worker does the same when no session host exists.

import { type UpdateHost } from './platform';

/** The part of `chrome.runtime` (or Firefox's `browser.runtime`) the update uses. */
export interface ExtensionRuntime {
  readonly onUpdateAvailable: { addListener(listener: () => void): void };
  reload(): void;
}

/** The extension's runtime; `undefined` outside an extension page (the tests, the dev server). */
export function extensionRuntime(): ExtensionRuntime | undefined {
  return (globalThis as { chrome?: { runtime?: ExtensionRuntime } }).chrome?.runtime;
}

export function deferUpdates(runtime: ExtensionRuntime, host: UpdateHost): void {
  let pending = false;
  const apply = (): void => {
    if (!pending || !host.idle()) return;
    pending = false;
    runtime.reload();
  };
  runtime.onUpdateAvailable.addListener(() => {
    pending = true;
    apply();
  });
  host.subscribe(apply);
}
