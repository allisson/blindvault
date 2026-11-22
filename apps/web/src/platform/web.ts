// The web app's platform: the page's clipboard and visibility, and the service worker (overview §7,
// §11, D54, D63, D151, D190, D191). Browser objects are looked up on use, so importing this module
// needs no DOM.

// A type only: `app/clipboard` reads the platform when it loads.
import type { ClipboardPort } from '../app/clipboard';
import { registerServiceWorker } from '../app/service-worker';
import { type LockSignals, type Platform } from './platform';

const ACTIVITY = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

/** The browser's clipboard, written only while the page has the focus. */
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

/** The page hidden, and input in it. The web knows no operating-system lock. */
export const pageLockSignals: LockSignals = {
  hidden: () => document.visibilityState === 'hidden',
  onHidden: (listener) => {
    const changed = () => {
      listener(document.visibilityState === 'hidden');
    };
    document.addEventListener('visibilitychange', changed);
    return () => {
      document.removeEventListener('visibilitychange', changed);
    };
  },
  onActivity: (listener) => {
    for (const type of ACTIVITY) window.addEventListener(type, listener, { passive: true });
    return () => {
      for (const type of ACTIVITY) window.removeEventListener(type, listener);
    };
  },
  onSystemLock: () => () => undefined,
};

export const webPlatform: Platform = {
  kind: 'web',
  clipboard: browserClipboard,
  lockSignals: pageLockSignals,
  startUpdates: (monitor) => {
    // The production build only: the dev server serves modules that no asset manifest lists (D190).
    // The registration starts before the first render, so the monitor watches it as early as it can
    // (D191).
    if (!import.meta.env.PROD) return;
    void registerServiceWorker(
      'serviceWorker' in navigator ? navigator.serviceWorker : undefined,
      (globalThis as { trustedTypes?: Parameters<typeof registerServiceWorker>[1] }).trustedTypes,
    ).then((registration) => {
      if (!registration) return;
      monitor.watch(registration);
      monitor.look();
    });
    // No browser looks for a changed sw.js on its own while a page stays open (D162).
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') monitor.look();
    });
  },
};
