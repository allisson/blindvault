// The app as a page of the browser extension (extension.md §2): `vite build --mode extension` leaves
// public/ out, so the page drops its links to the web manifest and the Apple icon, and the build
// copies only the icons the extension uses (its manifest names the PNGs, the pages the SVG). The
// popup (`popup.html`) is the build's second entry.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { type Plugin } from 'vite';

export const EXTENSION_ICONS = ['icon.svg', 'icon-192.png', 'icon-512.png'] as const;

const WEB_ONLY = [/^\s*<link rel="manifest"[^>]*>\n/m, /^\s*<link rel="apple-touch-icon"[^>]*>\n/m];

export function extensionHtml(html: string): string {
  return WEB_ONLY.reduce((page, link) => {
    if (!link.test(page)) throw new Error(`index.html: no line matches ${String(link)}`);
    return page.replace(link, '');
  }, html);
}

export function extensionPage(publicDir: URL): Plugin {
  return {
    name: 'blindvault-extension-page',
    apply: 'build',
    // The popup's page has no link of the web's to drop.
    transformIndexHtml: {
      order: 'pre',
      handler: (html, ctx) => (ctx.filename.endsWith('/index.html') ? extensionHtml(html) : html),
    },
    generateBundle() {
      for (const name of EXTENSION_ICONS) {
        this.emitFile({
          type: 'asset',
          fileName: name,
          source: readFileSync(new URL(name, publicDir)),
        });
      }
    },
  };
}

/** The extension build's pages: the app, which is the session host, and the popup. */
export function extensionInput(root: URL): Record<string, string> {
  return {
    index: fileURLToPath(new URL('index.html', root)),
    popup: fileURLToPath(new URL('popup.html', root)),
  };
}
