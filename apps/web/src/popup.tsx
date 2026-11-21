// The extension's popup (extension.md §1, §6): a second entry of the extension build. It holds no
// key, opens no vault database and starts no worker; it only asks the session host.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { startAppearance } from './app/appearance';
import { activeTab, popupRuntime } from './extension/popup-client';
import { LanguageProvider } from './i18n/context';
import { Popup } from './ui/Popup';
import './index.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Missing #root element');
}

startAppearance();
const runtime = popupRuntime();
if (runtime) {
  createRoot(root).render(
    <StrictMode>
      <LanguageProvider>
        <Popup
          runtime={runtime}
          tab={activeTab}
          close={() => {
            window.close();
          }}
        />
      </LanguageProvider>
    </StrictMode>,
  );
}
