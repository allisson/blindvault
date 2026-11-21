import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { extensionHtml, extensionInput } from './extension';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

describe('extensionHtml', () => {
  it('drops the links to the web manifest and the Apple icon, and keeps the rest', () => {
    const page = extensionHtml(html);
    expect(page).not.toContain('manifest.webmanifest');
    expect(page).not.toContain('apple-touch-icon');
    expect(page).toContain('<link rel="icon" href="/icon.svg"');
    expect(page.split('\n')).toHaveLength(html.split('\n').length - 2);
  });

  it('fails when index.html no longer has a link it drops', () => {
    expect(() => extensionHtml(extensionHtml(html))).toThrow(/no line matches/);
  });
});

describe('extensionInput', () => {
  it('builds the app and the popup', () => {
    const input = extensionInput(new URL('../', import.meta.url));
    expect(Object.keys(input)).toEqual(['index', 'popup']);
    expect(input.popup).toMatch(/[/\\]popup\.html$/);
  });
});
