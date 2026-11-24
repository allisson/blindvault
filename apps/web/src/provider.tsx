// The Android provider window (android.md §7.1, §7.7, D301): the second entry of the Android build,
// which the shell loads for one Credential Manager request. It is an app window of the vault (D51):
// it takes the vault over from the main window, unlocks, signs or saves on the user's tap, answers
// once, and locks. It starts no pairing, sync or update flow.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { supported } from './App';
import { startAppearance } from './app/appearance';
import { VaultController } from './app/controller';
import { startKdfWorker } from './app/kdf';
import { ProviderFlow } from './app/provider-flow';
import { LanguageProvider } from './i18n/context';
import { platform } from './platform';
import { shell } from './platform/android';
import { ProviderWindow } from './ui/ProviderWindow';
import './index.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Missing #root element');
}

startAppearance();
const bridge = shell();
if (bridge && supported() && platform.keystore) {
  const kdf = startKdfWorker();
  const controller = new VaultController({
    factory: indexedDB,
    locks: navigator.locks,
    kdf: () => kdf.port(),
    preload: () => kdf.ready(),
    storage: navigator.storage,
    keystore: platform.keystore,
  });
  const flow = new ProviderFlow({
    app: controller,
    shell: {
      request: () => bridge.request('provider-request'),
      result: (result) => {
        // The shell answers Credential Manager and finishes the activity; it sends no answer.
        bridge.request('provider-result', { result }).catch(() => undefined);
      },
    },
    now: Date.now,
  });
  // The screen turning off locks at once (§4.2), which ends the request; leaving the window ends
  // it in the shell (§7.1).
  platform.lockSignals.onSystemLock(() => {
    flow.end();
  });
  void controller.start().then(() => flow.start());
  createRoot(root).render(
    <StrictMode>
      <LanguageProvider>
        <ProviderWindow controller={controller} flow={flow} />
      </LanguageProvider>
    </StrictMode>,
  );
}
