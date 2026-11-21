// The passkey confirmation window (extension.md §7.4, §7.7): a third entry of the extension build. It
// holds no key, opens no vault database and starts no worker; it asks the session host for the
// request its token names, and sends the user's choice.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { startAppearance } from './app/appearance';
import { popupRuntime } from './extension/popup-client';
import { HEX_32 } from './extension/passkey-options';
import { LanguageProvider } from './i18n/context';
import { Confirm } from './ui/Confirm';
import './index.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Missing #root element');
}

startAppearance();
const runtime = popupRuntime();
// The token names a request of the session host, which it answers only while that request is
// pending: no vault state (D167, extension.md §7.7, D289).
// eslint-disable-next-line no-restricted-properties -- the window's token, not vault state
const token = location.hash.slice(1);
const close = () => {
  window.close();
};
if (runtime && HEX_32.test(token)) {
  createRoot(root).render(
    <StrictMode>
      <LanguageProvider>
        <Confirm runtime={runtime} token={token} close={close} />
      </LanguageProvider>
    </StrictMode>,
  );
} else {
  close();
}
