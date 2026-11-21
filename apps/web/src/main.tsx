import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { answerLink, offerLink, startInitiator, startResponder } from '@blindvault/sync';
import { App, supported } from './App';
import { startAppearance } from './app/appearance';
import { manifestHash } from './app/build-info';
import { VaultController } from './app/controller';
import { framed } from './app/frame';
import { startKdfWorker } from './app/kdf';
import { browserPasskeys } from './app/passkey';
import { loadStunSettings } from './app/stun-settings';
import { preloadStrength } from './app/strength';
import { UpdateMonitor } from './app/updates';
import { LanguageProvider } from './i18n/context';
import { platform } from './platform';
import { Framed } from './ui/Framed';
import './index.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Missing #root element');
}

// Theme and accent apply before the first render, in a frame too (D231).
startAppearance();

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

  // Before the first render, so the monitor watches the update flow as early as it can (D191).
  platform.startUpdates(monitor);

  createRoot(root).render(
    <StrictMode>
      <App controller={controller} monitor={monitor} />
    </StrictMode>,
  );
}
