import { describe, expect, it } from 'vitest';

import type { Field, Item } from './item';
import { fieldUrl, fillablePage, itemMatches, matchingUrl } from './match';

function login(urls: readonly (string | Partial<Field>)[], extra: Partial<Item> = {}): Item {
  return {
    templateId: 'login',
    templateVersion: 1,
    title: 'Example',
    fields: urls.map((u) =>
      typeof u === 'string'
        ? { type: 'url', value: u, label: 'Site' }
        : ({ type: 'url', label: 'Site', ...u } as Field),
    ),
    tags: [],
    ...extra,
  };
}

const domain = (value: string): Partial<Field> => ({ value, match: 'domain' });

describe('fillablePage', () => {
  it('takes https and http on localhost only', () => {
    expect(fillablePage('https://example.com/login')?.origin).toBe('https://example.com');
    expect(fillablePage('http://localhost:5310/')?.origin).toBe('http://localhost:5310');
    expect(fillablePage('http://example.com/')).toBeNull();
    expect(fillablePage('http://127.0.0.1/')).toBeNull();
    expect(fillablePage('file:///etc/passwd')).toBeNull();
    expect(fillablePage('data:text/html,x')).toBeNull();
    expect(fillablePage('chrome-extension://abc/index.html')).toBeNull();
    expect(fillablePage('not a url')).toBeNull();
  });
});

describe('fieldUrl', () => {
  it('reads a value with no scheme as https', () => {
    expect(fieldUrl('example.com/login')?.origin).toBe('https://example.com');
    expect(fieldUrl('  example.com  ')?.origin).toBe('https://example.com');
    expect(fieldUrl('example.com:8443/x')?.origin).toBe('https://example.com:8443');
  });

  it('skips another scheme, an http site and a value that does not parse', () => {
    expect(fieldUrl('mailto:alice@example.com')).toBeNull();
    expect(fieldUrl('javascript:alert(1)')).toBeNull();
    expect(fieldUrl('ftp://example.com')).toBeNull();
    expect(fieldUrl('http://example.com')).toBeNull();
    expect(fieldUrl('https://')).toBeNull();
    expect(fieldUrl('https://exa mple.com')).toBeNull();
  });

  it('keeps http on localhost', () => {
    expect(fieldUrl('http://localhost:3000')?.origin).toBe('http://localhost:3000');
  });

  it('gives the host in its ASCII form', () => {
    expect(fieldUrl('https://BÜCHER.example')?.hostname).toBe('xn--bcher-kva.example');
  });
});

describe('itemMatches, exact origin', () => {
  const item = login(['https://example.com']);

  it('matches the same origin, whatever the path', () => {
    expect(itemMatches(item, 'https://example.com:443/login?next=/')).toBe(true);
  });

  it('refuses another host, port or scheme', () => {
    expect(itemMatches(item, 'https://www.example.com/')).toBe(false);
    expect(itemMatches(item, 'https://example.com:8443/')).toBe(false);
    expect(itemMatches(item, 'http://example.com/')).toBe(false);
    expect(itemMatches(item, 'https://example.com.evil.test/')).toBe(false);
    expect(itemMatches(item, 'https://evilexample.com/')).toBe(false);
  });

  it('compares punycode and Unicode hosts alike', () => {
    expect(itemMatches(login(['bücher.example']), 'https://xn--bcher-kva.example/')).toBe(true);
  });

  it('matches when any url field matches', () => {
    expect(itemMatches(login(['mailto:x@y.z', 'example.com']), 'https://example.com/')).toBe(true);
  });

  it('matches http on localhost only on the same port', () => {
    const local = login(['http://localhost:3000']);
    expect(itemMatches(local, 'http://localhost:3000/')).toBe(true);
    expect(itemMatches(local, 'http://localhost:3001/')).toBe(false);
  });
});

describe('itemMatches, whole domain', () => {
  it('matches every host of the registrable domain, on https only', () => {
    const item = login([domain('https://example.com')]);
    expect(itemMatches(item, 'https://login.example.com/')).toBe(true);
    expect(itemMatches(item, 'https://a.b.example.com:8443/')).toBe(true);
    expect(itemMatches(item, 'https://example.org/')).toBe(false);
    expect(itemMatches(item, 'https://example.com.evil.test/')).toBe(false);
  });

  it('does not widen a private-section suffix to its siblings', () => {
    const item = login([domain('https://alice.github.io')]);
    expect(itemMatches(item, 'https://alice.github.io/')).toBe(true);
    expect(itemMatches(item, 'https://mallory.github.io/')).toBe(false);
  });

  it('falls back to the exact origin for an IP address, a public suffix and localhost', () => {
    const ip = login([domain('https://192.168.0.1')]);
    expect(itemMatches(ip, 'https://192.168.0.1/')).toBe(true);
    expect(itemMatches(ip, 'https://192.168.0.2/')).toBe(false);
    const suffix = login([domain('https://github.io')]);
    expect(itemMatches(suffix, 'https://github.io/')).toBe(true);
    expect(itemMatches(suffix, 'https://alice.github.io/')).toBe(false);
    const local = login([domain('http://localhost:3000')]);
    expect(itemMatches(local, 'http://localhost:3000/')).toBe(true);
    expect(itemMatches(local, 'http://localhost:3001/')).toBe(false);
  });

  it('does not let the flag on one field widen another', () => {
    const item = login(['https://example.com', domain('https://example.org')]);
    expect(itemMatches(item, 'https://www.example.com/')).toBe(false);
    expect(itemMatches(item, 'https://www.example.org/')).toBe(true);
  });
});

describe('itemMatches, items that never match', () => {
  it('refuses a trashed item, another template and a page that is not fillable', () => {
    const trashed = login(['https://example.com'], { trashOperationId: new Uint8Array(16) });
    expect(itemMatches(trashed, 'https://example.com/')).toBe(false);
    const card = login(['https://example.com'], { templateId: 'card' });
    expect(itemMatches(card, 'https://example.com/')).toBe(false);
    expect(itemMatches(login(['https://example.com']), 'not a url')).toBe(false);
  });

  it('ignores a field of another type holding the URL', () => {
    const item = login([{ type: 'text', value: 'https://example.com' }]);
    expect(itemMatches(item, 'https://example.com/')).toBe(false);
  });
});

describe('matchingUrl', () => {
  it('gives the first url field that matches, as written', () => {
    const item = login(['mailto:x@y.z', 'https://example.org', ' example.com/login ']);
    expect(matchingUrl(item, 'https://example.com/')).toBe(' example.com/login ');
    expect(matchingUrl(item, 'https://example.net/')).toBeNull();
  });

  it('gives null for an item that never matches', () => {
    const trashed = login(['https://example.com'], { trashOperationId: new Uint8Array(16) });
    expect(matchingUrl(trashed, 'https://example.com/')).toBeNull();
  });
});
