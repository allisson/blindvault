import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { HEADER_CSP } from './csp';
import { HEADERS_FILE, pagesHeaders } from './pages';

const NOT_FOUND = readFileSync(new URL('../public/404.html', import.meta.url), 'utf8');

describe('Cloudflare Pages _headers (D195, D228, D229)', () => {
  it('is the headers file Pages reads', () => {
    expect(HEADERS_FILE).toBe('_headers');
  });

  it('sends the policy of build/csp.ts and the headers of deploy/ on every path, as one rule', () => {
    expect(pagesHeaders()).toBe(
      [
        '/*',
        `  Content-Security-Policy: ${HEADER_CSP}`,
        '  Referrer-Policy: no-referrer',
        '  X-Content-Type-Options: nosniff',
        '  Strict-Transport-Security: max-age=31536000',
        '  Cross-Origin-Opener-Policy: same-origin',
        '  Cache-Control: no-cache',
        '  ! Access-Control-Allow-Origin',
        '',
      ].join('\n'),
    );
  });

  it("stays within Pages' limits: 100 rules, 2,000 characters per line", () => {
    const lines = pagesHeaders().split('\n');
    expect(lines.filter((l) => l !== '' && !l.startsWith(' ')).length).toBeLessThanOrEqual(100);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(2000);
  });
});

describe('404 page (D195, D229)', () => {
  it('runs nothing and styles nothing', () => {
    expect(NOT_FOUND).not.toMatch(/<script|<style|\sstyle=|\son[a-z]+=|<link|<iframe|<object/i);
  });

  it('sends no referrer and links to the app', () => {
    expect(NOT_FOUND).toContain('<meta name="referrer" content="no-referrer" />');
    expect([...NOT_FOUND.matchAll(/href="([^"]*)"/g)].map((m) => m[1])).toEqual(['/']);
  });

  it('says it in English and Brazilian Portuguese', () => {
    expect(NOT_FOUND).toContain('<html lang="en">');
    expect(NOT_FOUND).toContain('lang="pt-BR"');
  });
});
