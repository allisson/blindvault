import { describe, expect, it } from 'vitest';

import { HOST_TYPES, POPUP_TYPES, QUERY_MAX, fromPage, parseRequest } from './rpc';

const ITEM = '0123456789abcdef0123456789abcdef';

describe('parseRequest (extension.md §4)', () => {
  it.each([
    [{ v: 1, type: 'status', id: 0 }],
    [{ v: 1, type: 'lock', id: 3 }],
    [{ v: 1, type: 'search', id: 1, query: '' }],
    [{ v: 1, type: 'search', id: 1, query: 'x'.repeat(QUERY_MAX) }],
    [{ v: 1, type: 'copy', id: 2, itemId: ITEM, field: 'password' }],
    [{ v: 1, type: 'copy', id: 2, itemId: ITEM, field: 'totp' }],
    [{ v: 1, type: 'matches', id: 3, tabId: 0 }],
    [{ v: 1, type: 'fill', id: 4, tabId: 12, itemId: ITEM }],
    [{ v: 1, type: 'command-fill', id: 0, tabId: 12 }],
  ])('takes %j', (message) => {
    expect(parseRequest(message, HOST_TYPES)).toEqual({ kind: 'request', request: message });
  });

  it.each([
    ['an unknown version', { v: 2, type: 'status', id: 0 }, 0],
    ['a version as text', { v: '1', type: 'status', id: 0 }, 0],
    ['an unknown type', { v: 1, type: 'export', id: 0 }, 0],
    ['an unknown key', { v: 1, type: 'status', id: 0, tabId: 1 }, 0],
    ['a key of another type', { v: 1, type: 'lock', id: 0, query: 'x' }, 0],
    ['a fractional ID', { v: 1, type: 'status', id: 0.5 }, undefined],
    ['a negative ID', { v: 1, type: 'status', id: -1 }, undefined],
    ['no ID', { v: 1, type: 'status' }, undefined],
    ['a query too long', { v: 1, type: 'search', id: 0, query: 'x'.repeat(QUERY_MAX + 1) }, 0],
    ['a query not text', { v: 1, type: 'search', id: 0, query: 1 }, 0],
    ['a short item ID', { v: 1, type: 'copy', id: 0, itemId: 'abcd', field: 'password' }, 0],
    [
      'an item ID in capitals',
      { v: 1, type: 'copy', id: 0, itemId: ITEM.toUpperCase(), field: 'password' },
      0,
    ],
    ['a field it cannot copy', { v: 1, type: 'copy', id: 0, itemId: ITEM, field: 'notes' }, 0],
    ['no tab', { v: 1, type: 'matches', id: 0 }, 0],
    ['a negative tab', { v: 1, type: 'matches', id: 0, tabId: -1 }, 0],
    ['a tab as text', { v: 1, type: 'command-fill', id: 0, tabId: '3' }, 0],
    ['a URL beside the tab', { v: 1, type: 'matches', id: 0, tabId: 1, url: 'https://a.b' }, 0],
    ['a fill with no item', { v: 1, type: 'fill', id: 0, tabId: 1 }, 0],
    ['a fill of a bad item ID', { v: 1, type: 'fill', id: 0, tabId: 1, itemId: 'x' }, 0],
    [
      'a fill carrying an origin',
      { v: 1, type: 'fill', id: 0, tabId: 1, itemId: ITEM, origin: 'https://a.b' },
      0,
    ],
  ])('refuses %s', (_name, message, id) => {
    expect(parseRequest(message, HOST_TYPES)).toEqual(
      id === undefined ? { kind: 'invalid' } : { kind: 'invalid', id },
    );
  });

  it.each([null, 'status', 1, [], [{ v: 1, type: 'status', id: 0 }], new Date()])(
    'refuses %j, not a plain object',
    (message) => {
      expect(parseRequest(message, HOST_TYPES)).toEqual({ kind: 'invalid' });
    },
  );

  it('leaves to another receiver a valid type it does not act on', () => {
    expect(parseRequest({ v: 1, type: 'open-host', id: 0 }, HOST_TYPES)).toEqual({ kind: 'other' });
    expect(parseRequest({ v: 1, type: 'status', id: 0 }, POPUP_TYPES)).toEqual({ kind: 'other' });
  });

  it('reads the confirmation window’s choices (§7.7)', () => {
    const token = 'c'.repeat(32);
    const choice = (extra: object) =>
      parseRequest({ v: 1, type: 'confirm-choice', id: 1, token, ...extra }, HOST_TYPES);
    expect(choice({ choice: 'use', credentialId: '0a1b' })).toEqual({
      kind: 'request',
      request: {
        v: 1,
        type: 'confirm-choice',
        id: 1,
        token,
        choice: { choice: 'use', credentialId: '0a1b' },
      },
    });
    expect(choice({ choice: 'save', itemId: ITEM })).toMatchObject({ kind: 'request' });
    for (const c of ['save-new', 'browser', 'cancel']) {
      expect(choice({ choice: c })).toMatchObject({ kind: 'request' });
    }
    for (const bad of [
      { choice: 'use' },
      { choice: 'use', credentialId: '0A1B' },
      { choice: 'use', credentialId: 'abc' },
      { choice: 'use', credentialId: 'ab'.repeat(1024) },
      { choice: 'use', credentialId: '0a', itemId: ITEM },
      { choice: 'save', itemId: 'x' },
      { choice: 'save', itemId: ITEM, credentialId: '0a' },
      { choice: 'cancel', itemId: ITEM },
      { choice: 'sign' },
    ]) {
      expect(choice(bad)).toEqual({ kind: 'invalid', id: 1 });
    }
    expect(
      parseRequest({ v: 1, type: 'confirm-details', id: 1, token: 'C'.repeat(32) }, HOST_TYPES),
    ).toEqual({ kind: 'invalid', id: 1 });
    expect(
      parseRequest({ v: 1, type: 'confirm-choice', id: 1, choice: 'cancel' }, HOST_TYPES),
    ).toEqual({ kind: 'invalid', id: 1 });
  });

  it('leaves passkey-answer, the session host’s own message, to the service worker', () => {
    const answer = {
      v: 1,
      type: 'passkey-answer',
      id: 0,
      tabId: 1,
      frameId: 0,
      request: 'a',
      result: {},
    };
    expect(parseRequest(answer, HOST_TYPES)).toEqual({ kind: 'other' });
    expect(parseRequest({ ...answer, extra: 1 }, HOST_TYPES)).toEqual({ kind: 'invalid', id: 0 });
  });

  it('refuses a malformed message of another receiver’s type', () => {
    expect(parseRequest({ v: 1, type: 'open-host', id: 0, url: 'x' }, HOST_TYPES)).toEqual({
      kind: 'invalid',
      id: 0,
    });
  });
});

describe('fromPage (extension.md §4)', () => {
  const runtime = { id: 'abc', getURL: (path: string) => `chrome-extension://abc/${path}` };

  it('takes the extension’s own page, with or without a fragment', () => {
    expect(
      fromPage({ id: 'abc', url: 'chrome-extension://abc/popup.html' }, runtime, ['popup.html']),
    ).toBe(true);
    expect(
      fromPage({ id: 'abc', url: 'chrome-extension://abc/popup.html#x' }, runtime, ['popup.html']),
    ).toBe(true);
  });

  it.each([
    [
      'a content script, with the web page’s URL',
      { id: 'abc', url: 'https://example.com/popup.html' },
    ],
    ['another page of the extension', { id: 'abc', url: 'chrome-extension://abc/index.html' }],
    ['another extension', { id: 'xyz', url: 'chrome-extension://xyz/popup.html' }],
    ['a sender with no URL', { id: 'abc' }],
    ['a sender with no ID', { url: 'chrome-extension://abc/popup.html' }],
    ['a longer path', { id: 'abc', url: 'chrome-extension://abc/popup.html/x' }],
  ])('refuses %s', (_name, sender) => {
    expect(fromPage(sender, runtime, ['popup.html'])).toBe(false);
  });
});
