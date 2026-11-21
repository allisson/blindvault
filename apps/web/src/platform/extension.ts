// The extension's platform (extension.md §2). The extension registers no service worker of the app:
// its code comes from the package (D282), and its update is reloaded once the vault is locked (§8.1);
// the version lock (§8.2) is `app/version-lock.ts`. The locks count the browser's focus and the
// operating system's lock (§3.2, D284), and the clipboard's clear is the service worker's (§6.3).

import { extensionApi, extensionClipboard, extensionLockSignals } from './extension-locks';
import { deferUpdates, extensionRuntime } from './extension-updates';
import { type Platform } from './platform';
import { browserClipboard, pageLockSignals } from './web';

/** The session host's activity outside its page, for its messages (`extension/host.ts`). */
export const extensionLocks = extensionLockSignals(extensionApi, pageLockSignals);

export const extensionPlatform: Platform = {
  kind: 'extension',
  clipboard: extensionClipboard(extensionApi, (text) => browserClipboard.write(text)),
  lockSignals: extensionLocks,
  startUpdates: (_monitor, host) => {
    const runtime = extensionRuntime();
    if (runtime) deferUpdates(runtime, host);
  },
};
