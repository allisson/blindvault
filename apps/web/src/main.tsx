import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { answerLink, offerLink, startInitiator, startResponder } from '@blindvault/sync';
import { App, supported } from './App';
import { startAppearance } from './app/appearance';
import { manifestHash } from './app/build-info';
import { clipboard } from './app/clipboard';
import { VaultController } from './app/controller';
import { framed } from './app/frame';
import { startKdfWorker } from './app/kdf';
import { browserPasskeys } from './app/passkey';
import { loadStunSettings } from './app/stun-settings';
import { preloadStrength } from './app/strength';
import { UpdateMonitor } from './app/updates';
import { VersionLock, vaultExists } from './app/version-lock';
import { extensionTabs } from './extension/fill';
import { hostRuntime, serveHost } from './extension/host';
import { browserPasskeySwitch, browserWindows, windowToken } from './extension/passkey-browser';
import { PasskeyHost } from './extension/passkey-host';
import { nextId } from './extension/rpc';
import { LanguageProvider } from './i18n/context';
import { platform } from './platform';
import { extensionLocks } from './platform/extension';
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
  platform.startUpdates(monitor, {
    idle: () => controller.status.kind !== 'unlocked' && controller.updateAllowed,
    subscribe: controller.subscribe,
  });

  // The extension's version lock reads the build this window loaded (extension.md §8.2). The mode
  // is replaced at build time, so the web build carries none of it.
  const versionLock =
    import.meta.env.MODE === 'extension'
      ? new VersionLock({
          storage: localStorage,
          running: async () => {
            const hash = await manifestHash();
            return hash === undefined ? undefined : { version: __APP_VERSION__, hash };
          },
          vaultExists: () => vaultExists(controller),
        })
      : undefined;
  void versionLock?.start();

  // The session host answers the popup, the confirmation window and the service worker (extension.md
  // §4), and holds the pending passkey request (§7.7).
  const runtime = import.meta.env.MODE === 'extension' ? hostRuntime() : undefined;
  if (runtime) {
    const windows = browserWindows();
    const passkeys = windows
      ? new PasskeyHost({
          app: controller,
          windows,
          answer: (answer) => {
            // No service worker listening: the page's call ends at its own timeout.
            runtime
              .sendMessage({ v: 1, type: 'passkey-answer', id: nextId(), ...answer })
              .catch(() => undefined);
          },
          token: windowToken,
          now: Date.now,
        })
      : undefined;
    // A registration lost in an update comes back at start (§7.1, D289).
    void browserPasskeySwitch()
      ?.restore()
      .catch(() => undefined);
    serveHost(runtime, {
      app: controller,
      activity: () => {
        extensionLocks.touch();
      },
      copied: (seconds) => {
        clipboard.copied(seconds);
      },
      now: Date.now,
      tabs: extensionTabs(),
      passkeys,
    });
  }

  createRoot(root).render(
    <StrictMode>
      <App controller={controller} monitor={monitor} versionLock={versionLock} />
    </StrictMode>,
  );
}
