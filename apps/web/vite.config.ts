import { readFileSync } from 'node:fs';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { type Plugin, defineConfig } from 'vite';

import { androidInput, androidPage } from './build/android';
import { assetManifest } from './build/asset-manifest';
import { META_CSP } from './build/csp';
import { extensionInput, extensionPage } from './build/extension';
import { pagesHeadersFile } from './build/pages';
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

// `--mode extension` builds the app for apps/extension (extension.md §2): no public/ (its sw.js,
// 404.html and web manifest are the web's), no `_headers`, and the icons the extension's manifest
// names. apps/extension writes the package's own asset manifest over this one. `--mode android`
// builds it for apps/android (android.md §2) the same way, with `headers.json` for the shell.
export default defineConfig(({ mode }) => {
  const publicDir = new URL('./public/', import.meta.url);
  const root = new URL('./', import.meta.url);
  const packaged =
    mode === 'extension'
      ? { page: extensionPage(publicDir), outDir: 'dist-extension', input: extensionInput(root) }
      : mode === 'android'
        ? { page: androidPage(publicDir), outDir: 'dist-android', input: androidInput(root) }
        : undefined;
  return {
    plugins: [
      react(),
      tailwindcss(),
      csp(),
      versionText(pkg.version),
      packaged ? packaged.page : pagesHeadersFile(),
      assetManifest(new URL('../../.nvmrc', import.meta.url)),
    ],
    ...(packaged
      ? {
          publicDir: false as const,
          build: { outDir: packaged.outDir, rollupOptions: { input: packaged.input } },
        }
      : {}),
    // The Argon2id worker is built as a module, as the dev server serves it (app/kdf.ts).
    worker: { format: 'es' },
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
  };
});
