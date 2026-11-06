// `_headers` for Cloudflare Pages (D228, D229): the headers of deploy/ (D195) as one rule on every
// path, since Pages joins the values of a header that several matching rules set. Pages reads the
// file and does not serve it, so the asset manifest leaves it out.

import { type Plugin } from 'vite';

import { HEADER_CSP } from './csp';

export const HEADERS_FILE = '_headers';

export function pagesHeaders(): string {
  return [
    '/*',
    `  Content-Security-Policy: ${HEADER_CSP}`,
    '  Referrer-Policy: no-referrer',
    '  X-Content-Type-Options: nosniff',
    '  Strict-Transport-Security: max-age=31536000',
    '  Cross-Origin-Opener-Policy: same-origin',
    '  Cache-Control: no-cache',
    // Pages sends `Access-Control-Allow-Origin: *` by default; deploy/ sends none.
    '  ! Access-Control-Allow-Origin',
    '',
  ].join('\n');
}

export function pagesHeadersFile(): Plugin {
  return {
    name: 'blindvault-pages-headers',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: HEADERS_FILE, source: pagesHeaders() });
    },
  };
}
