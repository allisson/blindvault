import { readFileSync } from 'node:fs';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { type Plugin, defineConfig } from 'vite';

import { assetManifest } from './build/asset-manifest';
import { META_CSP } from './build/csp';
import { versionText } from './build/version';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

// Only in the build: the dev server injects inline scripts for hot reload.
function csp(): Plugin {
  return {
    name: 'blindvault-csp',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: META_CSP },
        injectTo: 'head-prepend',
      },
    ],
  };
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    csp(),
    versionText(pkg.version),
    assetManifest(new URL('../../.nvmrc', import.meta.url)),
  ],
  // The Argon2id worker is built as a module, as the dev server serves it (app/kdf.ts).
  worker: { format: 'es' },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
});
