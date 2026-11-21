import { describe, expect, it, vi } from 'vitest';

import {
  clearClipboard,
  command,
  findHost,
  openHost,
  parseRequest,
  start,
  updateAvailable,
} from './background.js';

const BASE = 'chrome-extension://abc/';

function api(contexts: { documentUrl?: string; tabId: number; windowId: number }[]) {
  const listeners: Record<string, (...args: unknown[]) => unknown> = {};
  const on = (name: string) => ({
    addListener: (listener: (...args: never[]) => unknown) => {
      listeners[name] = listener as (...args: unknown[]) => unknown;
    },
  });
  return {
    listeners,
    runtime: {
      id: 'abc',
      getURL: (path: string) => BASE + path,
      getContexts: vi.fn(() => Promise.resolve(contexts)),
      reload: vi.fn(),
      sendMessage: vi.fn(() => Promise.resolve()),
      onUpdateAvailable: on('update'),
      onMessage: on('message'),
    },
    action: { openPopup: vi.fn(() => Promise.resolve()) },
    commands: { onCommand: on('command') },
    tabs: { create: vi.fn(() => Promise.resolve()), update: vi.fn(() => Promise.resolve()) },
    windows: { update: vi.fn(() => Promise.resolve()) },
  };
}

const HOST = { documentUrl: `${BASE}index.html`, tabId: 7, windowId: 3 };
const OTHER = { documentUrl: `${BASE}popup.html`, tabId: 8, windowId: 3 };

describe('the service worker (extension.md §1, §8.1)', () => {
  it('finds the session host among the extension’s tabs', async () => {
    await expect(findHost(api([OTHER, HOST]))).resolves.toEqual(HOST);
    await expect(findHost(api([OTHER, { tabId: 9, windowId: 1 }]))).resolves.toBeUndefined();
  });

  it('opens the session host in a pinned tab when none exists', async () => {
    const a = api([OTHER]);
    await openHost(a);
    expect(a.tabs.create).toHaveBeenCalledWith({ url: `${BASE}index.html`, pinned: true });
  });

  it('focuses the session host when one exists', async () => {
    const a = api([HOST]);
    await openHost(a);
    expect(a.tabs.create).not.toHaveBeenCalled();
    expect(a.tabs.update).toHaveBeenCalledWith(7, { active: true });
    expect(a.windows.update).toHaveBeenCalledWith(3, { focused: true });
  });

  it('applies an update at once with no session host', async () => {
    const a = api([OTHER]);
    await updateAvailable(a);
    expect(a.runtime.reload).toHaveBeenCalledTimes(1);
  });

  it('leaves an update to the session host while one exists', async () => {
    const a = api([HOST]);
    await updateAvailable(a);
    expect(a.runtime.reload).not.toHaveBeenCalled();
  });

  it('listens to updates', async () => {
    const a = api([]);
    start(a);
    a.listeners.update?.();
    await vi.waitFor(() => {
      expect(a.runtime.reload).toHaveBeenCalledTimes(1);
    });
  });
});

describe('the fill command (extension.md §6.2, D286)', () => {
  it('locks on the session host’s own tab, where the browser took the app’s shortcut', async () => {
    const a = api([HOST]);
    await command(a, { id: 7 });
    expect(a.runtime.sendMessage).toHaveBeenCalledWith({ v: 1, type: 'lock', id: 0 });
    expect(a.action.openPopup).not.toHaveBeenCalled();
  });

  it('hands any other tab to the session host, which fills when one item matches', async () => {
    const a = api([HOST]);
    a.runtime.sendMessage.mockResolvedValue({ v: 1, id: 0, ok: true, result: 'filled' } as never);
    await command(a, { id: 9 });
    expect(a.runtime.sendMessage).toHaveBeenCalledWith({
      v: 1,
      type: 'command-fill',
      id: 0,
      tabId: 9,
    });
    expect(a.action.openPopup).not.toHaveBeenCalled();
  });

  it.each([
    ['the session host asks for it', { v: 1, id: 0, ok: true, result: 'popup' }],
    ['the answer is a refusal', { v: 1, id: 0, ok: false, error: 'invalid' }],
    ['the answer is not the session host’s', { v: 2, id: 0, ok: true, result: 'filled' }],
    ['there is no answer', undefined],
  ])('opens the popup when %s', async (_name, answer) => {
    const a = api([HOST]);
    a.runtime.sendMessage.mockResolvedValue(answer as never);
    await command(a, { id: 9 });
    expect(a.action.openPopup).toHaveBeenCalledTimes(1);
  });

  it('opens the popup when the session host cannot be reached', async () => {
    const a = api([HOST]);
    a.runtime.sendMessage.mockRejectedValue(new Error('Receiving end does not exist.'));
    await command(a, { id: 9 });
    expect(a.action.openPopup).toHaveBeenCalledTimes(1);
  });

  it('opens the popup with no session host', async () => {
    const a = api([]);
    start(a);
    a.listeners.command?.('fill', { id: 9 });
    a.listeners.command?.('other', { id: 9 });
    await vi.waitFor(() => {
      expect(a.action.openPopup).toHaveBeenCalledTimes(1);
    });
  });
});

const POPUP = { id: 'abc', url: `${BASE}popup.html` };
const HOST_SENDER = { id: 'abc', url: `${BASE}index.html` };

describe('the service worker’s messages (extension.md §4)', () => {
  const a = api([]);
  const open = { v: 1, type: 'open-host', id: 4 };
  const clear = { v: 1, type: 'clipboard-clear', id: 5 };

  it('takes open-host from the popup and clipboard-clear from the session host', () => {
    expect(parseRequest(open, POPUP, a)).toBe('open-host');
    expect(parseRequest(clear, HOST_SENDER, a)).toBe('clipboard-clear');
  });

  it.each([
    ['another page of the extension', HOST_SENDER, open],
    ['the popup asking a clear', POPUP, clear],
    ['a web page', { id: 'abc', url: 'https://example.com/popup.html' }, open],
    ['another extension', { id: 'xyz', url: 'chrome-extension://xyz/popup.html' }, open],
    ['no URL', { id: 'abc' }, open],
  ])('refuses %s', (_name, sender, message) => {
    expect(parseRequest(message, sender, a)).toBeNull();
  });

  it.each([
    ['an unknown version', { ...open, v: 2 }],
    ['an unknown type', { v: 1, type: 'fill-all', id: 1 }],
    ['an unknown key', { ...open, url: 'https://example.com' }],
    ['a missing ID', { v: 1, type: 'open-host' }],
    ['a negative ID', { ...open, id: -1 }],
    ['an array', [open]],
    ['a string', 'open-host'],
  ])('refuses %s', (_name, message) => {
    expect(parseRequest(message, POPUP, a)).toBeNull();
  });

  it('leaves the others’ messages to them', () => {
    expect(parseRequest({ v: 1, type: 'status', id: 1 }, POPUP, a)).toBeUndefined();
    expect(parseRequest({ v: 1, type: 'search', id: 1, query: 'x' }, POPUP, a)).toBeUndefined();
    expect(parseRequest({ v: 1, type: 'locked', id: 1 }, HOST_SENDER, a)).toBeUndefined();
    expect(parseRequest({ v: 1, type: 'matches', id: 1, tabId: 2 }, POPUP, a)).toBeUndefined();
    expect(
      parseRequest({ v: 1, type: 'fill', id: 1, tabId: 2, itemId: 'a' }, POPUP, a),
    ).toBeUndefined();
  });

  it('answers open-host by opening the session host', async () => {
    const b = api([]);
    start(b);
    const respond = vi.fn();
    expect(b.listeners.message?.(open, POPUP, respond)).toBe(true);
    await vi.waitFor(() => {
      expect(respond).toHaveBeenCalledWith({ v: 1, id: 4, ok: true });
    });
    expect(b.tabs.create).toHaveBeenCalledWith({ url: `${BASE}index.html`, pinned: true });
  });

  it('refuses a message from a web page with an error answer, and acts on nothing', () => {
    const b = api([]);
    start(b);
    const respond = vi.fn();
    expect(b.listeners.message?.(open, { id: 'abc', url: 'https://example.com/' }, respond)).toBe(
      false,
    );
    expect(respond).toHaveBeenCalledWith({ v: 1, id: 4, ok: false, error: 'invalid' });
    expect(b.tabs.create).not.toHaveBeenCalled();
  });

  it('stays silent on a message another page answers', () => {
    const b = api([]);
    start(b);
    const respond = vi.fn();
    expect(b.listeners.message?.({ v: 1, type: 'status', id: 1 }, POPUP, respond)).toBe(false);
    expect(respond).not.toHaveBeenCalled();
  });
});

describe('the clipboard’s clear (extension.md §6.3)', () => {
  it('uses an offscreen document on Chrome, closing any left open', async () => {
    const a = api([]);
    const offscreen = {
      hasDocument: vi.fn(() => Promise.resolve(true)),
      createDocument: vi.fn(() => Promise.resolve()),
      closeDocument: vi.fn(() => Promise.resolve()),
    };
    await clearClipboard({ ...a, offscreen }, undefined);
    expect(offscreen.createDocument).toHaveBeenCalledWith({
      url: 'offscreen.html',
      reasons: ['CLIPBOARD'],
      justification: 'Clears the clipboard after a copy.',
    });
    expect(offscreen.closeDocument).toHaveBeenCalledTimes(2);
  });

  it('writes the empty string itself on Firefox', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    await clearClipboard(api([]), { writeText });
    expect(writeText).toHaveBeenCalledWith('');
  });

  it('answers a clear from the session host', async () => {
    const a = api([]);
    const writeText = vi.fn(() => Promise.resolve());
    start(a, { writeText });
    const respond = vi.fn();
    a.listeners.message?.({ v: 1, type: 'clipboard-clear', id: 5 }, HOST_SENDER, respond);
    await vi.waitFor(() => {
      expect(respond).toHaveBeenCalledWith({ v: 1, id: 5, ok: true });
    });
    expect(writeText).toHaveBeenCalledWith('');
  });
});
