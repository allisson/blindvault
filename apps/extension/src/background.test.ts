import { describe, expect, it, vi } from 'vitest';

import { findHost, openHost, start, updateAvailable } from './background.js';

const BASE = 'chrome-extension://abc/';

function api(contexts: { documentUrl?: string; tabId: number; windowId: number }[]) {
  const listeners: Record<string, () => void> = {};
  const on = (name: string) => ({
    addListener: (listener: () => void) => {
      listeners[name] = listener;
    },
  });
  return {
    listeners,
    runtime: {
      id: 'abc',
      getURL: (path: string) => BASE + path,
      getContexts: vi.fn(() => Promise.resolve(contexts)),
      reload: vi.fn(),
      onUpdateAvailable: on('update'),
    },
    action: { onClicked: on('click') },
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

  it('listens to the button and to updates', async () => {
    const a = api([]);
    start(a);
    a.listeners.click?.();
    a.listeners.update?.();
    await vi.waitFor(() => {
      expect(a.tabs.create).toHaveBeenCalledTimes(1);
      expect(a.runtime.reload).toHaveBeenCalledTimes(1);
    });
  });
});
