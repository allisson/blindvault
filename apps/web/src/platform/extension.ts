// The extension's platform (extension.md §2). The extension registers no service worker of the app:
// its code comes from the package (D282), and its update flow is the version lock (§8). The
// clipboard clear without the focus (§6.3) and the extension's lock signals (§3.2, D284) need the
// session host's `chrome.*` access; until they exist the page's own are used.

import { type Platform } from './platform';
import { browserClipboard, pageLockSignals } from './web';

export const extensionPlatform: Platform = {
  kind: 'extension',
  clipboard: browserClipboard,
  lockSignals: pageLockSignals,
  startUpdates: () => undefined,
};
