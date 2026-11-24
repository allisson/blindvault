// The app for apps/android (android.md §2): `vite build --mode android` leaves public/ out, so the
// page drops its links to the web manifest and the Apple icon as the extension's does, and the build
// copies only the icon the page names. `headers.json` holds the headers `_headers` sets on `/*`,
// which the shell adds to every response, so the app runs under its real CSP (§3, D282).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { type Plugin } from 'vite';

import { extensionHtml } from './extension';
import { APP_HEADERS } from './pages';

export const ANDROID_HEADERS_FILE = 'headers.json';

export const ANDROID_ICONS = ['icon.svg'] as const;

/** `headers.json`: one object, header name to value, with a final newline. */
export function androidHeaders(): string {
  return `${JSON.stringify(Object.fromEntries(APP_HEADERS), null, 2)}\n`;
}

export function androidPage(publicDir: URL): Plugin {
  return {
    name: 'blindvault-android-page',
    apply: 'build',
    transformIndexHtml: {
      order: 'pre',
      // The provider window's page names no web manifest to drop.
      handler: (html, ctx) => (ctx.filename.endsWith('/index.html') ? extensionHtml(html) : html),
    },
    generateBundle() {
      for (const name of ANDROID_ICONS) {
        this.emitFile({
          type: 'asset',
          fileName: name,
          source: readFileSync(new URL(name, publicDir)),
        });
      }
      this.emitFile({ type: 'asset', fileName: ANDROID_HEADERS_FILE, source: androidHeaders() });
    },
  };
}

/** The Android build's pages: the main window and the provider window (android.md §2, §7.1). */
export function androidInput(root: URL): Record<string, string> {
  return {
    index: fileURLToPath(new URL('index.html', root)),
    provider: fileURLToPath(new URL('provider.html', root)),
  };
}
