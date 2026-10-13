import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { registerServiceWorker } from './app/service-worker';
import './index.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Missing #root element');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The production build only: the dev server serves modules that no asset manifest lists (D190).
if (import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void registerServiceWorker(
      'serviceWorker' in navigator ? navigator.serviceWorker : undefined,
      (globalThis as { trustedTypes?: Parameters<typeof registerServiceWorker>[1] }).trustedTypes,
    );
  });
}
