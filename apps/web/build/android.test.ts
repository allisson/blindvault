import { describe, expect, it } from 'vitest';

import { ANDROID_HEADERS_FILE, androidHeaders, androidInput } from './android';
import { HEADER_CSP } from './csp';
import { pagesHeaders } from './pages';

describe('the Android build (android.md §2)', () => {
  it('writes headers.json with the headers `_headers` sets on every path', () => {
    expect(ANDROID_HEADERS_FILE).toBe('headers.json');
    const headers = JSON.parse(androidHeaders()) as Record<string, string>;
    expect(headers).toEqual({
      'Content-Security-Policy': HEADER_CSP,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Strict-Transport-Security': 'max-age=31536000',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cache-Control': 'no-cache',
    });
    for (const [name, value] of Object.entries(headers)) {
      expect(pagesHeaders()).toContain(`  ${name}: ${value}\n`);
    }
    expect(androidHeaders().endsWith('}\n')).toBe(true);
  });

  it('builds the main window and the provider window (android.md §7.1)', () => {
    const input = androidInput(new URL('../', import.meta.url));
    expect(Object.keys(input)).toEqual(['index', 'provider']);
    expect(input.index).toMatch(/[/\\]index\.html$/);
    expect(input.provider).toMatch(/[/\\]provider\.html$/);
  });
});
