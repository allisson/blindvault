import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { answerLink, offerLink, startInitiator, startResponder } from '@blindvault/sync';
import { App, supported } from './App';
import { manifestHash } from './app/build-info';
import { VaultController } from './app/controller';
import { framed } from './app/frame';
import { startKdfWorker } from './app/kdf';
import { browserPasskeys } from './app/passkey';
import { registerServiceWorker } from './app/service-worker';
import { loadStunSettings } from './app/stun-settings';
import { preloadStrength } from './app/strength';
import { UpdateMonitor } from './app/updates';
import { LanguageProvider } from './i18n/context';
import { Framed } from './ui/Framed';
import './index.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Missing #root element');
}

// Inside a frame the app opens nothing: no vault database, no Web Lock, no worker, no manifest and no
// service worker, since `frame-ancestors` cannot be set by <meta> (D83, D193).
if (framed(window)) {
  createRoot(root).render(
    <StrictMode>
      <LanguageProvider>
        <Framed />
      </LanguageProvider>
    </StrictMode>,
  );
} else {
  start(root);
}

function start(root: HTMLElement): void {
  // Every piece of code the app may need after the first unlock loads now: the one Argon2id worker
  // of this window and the strength dictionaries. The start screen waits for both (D142, D191).
  const kdf = supported() ? startKdfWorker() : undefined;
  // The About screen names the bundle this window loaded: its manifest is read now (D192).
  void manifestHash();
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
    stun: loadStunSettings,
    ...(typeof RTCPeerConnection === 'undefined'
      ? {}
      : { pairing: { startInitiator, startResponder }, sync: { offerLink, answerLink } }),
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

  // The production build only: the dev server serves modules that no asset manifest lists (D190).
  // The registration starts before the first render, so the monitor watches it as early as it can
  // (D191).
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
}
