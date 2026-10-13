import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, supported } from './App';
import { VaultController } from './app/controller';
import { startKdfWorker } from './app/kdf';
import { browserPasskeys } from './app/passkey';
import { registerServiceWorker } from './app/service-worker';
import { preloadStrength } from './app/strength';
import { UpdateMonitor } from './app/updates';
import './index.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Missing #root element');
}

// Every piece of code the app may need after the first unlock loads now: the one Argon2id worker of
// this window and the strength dictionaries. The start screen waits for both (D142, D191).
const kdf = supported() ? startKdfWorker() : undefined;
const controller = new VaultController({
  factory: indexedDB,
  locks: navigator.locks,
  kdf: () => {
    if (!kdf) throw new Error('No Argon2id worker');
    return kdf.port();
  },
  preload: async () => {
    await Promise.all([kdf?.ready(), preloadStrength()]);
  },
  storage: navigator.storage,
  passkeys: browserPasskeys(),
});
const monitor = new UpdateMonitor({
  lock: () => {
    controller.lock();
  },
  reload: () => {
    location.reload();
  },
  allowed: () => controller.updateAllowed,
});

// The production build only: the dev server serves modules that no asset manifest lists (D190). The
// registration starts before the first render, so the monitor watches it as early as it can (D191).
if (import.meta.env.PROD) {
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
}

createRoot(root).render(
  <StrictMode>
    <App controller={controller} monitor={monitor} />
  </StrictMode>,
);
