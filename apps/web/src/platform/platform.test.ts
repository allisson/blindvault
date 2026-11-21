import { afterEach, describe, expect, it, vi } from 'vitest';

import { extensionPlatform } from './extension';
import { deferUpdates } from './extension-updates';
import { platform } from './index';
import { pageLockSignals, webPlatform } from './web';

afterEach(() => {
  vi.unstubAllGlobals();
});

function page(state: 'visible' | 'hidden') {
  const doc = Object.assign(new EventTarget(), { visibilityState: state });
  const win = new EventTarget();
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', win);
  return { doc, win };
}

function idleHost(idle: boolean) {
  const state = { idle };
  const listeners = new Set<() => void>();
  return {
    state,
    host: {
      idle: () => state.idle,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    changed: () => {
      for (const l of listeners) l();
    },
  };
}

function runtime() {
  let available: (() => void) | undefined;
  return {
    api: {
      onUpdateAvailable: {
        addListener: (listener: () => void) => {
          available = listener;
        },
      },
      reload: vi.fn(),
    },
    update: () => available?.(),
  };
}

describe('the platform (extension.md §2)', () => {
  it('is the web one outside an extension build', () => {
    expect(platform).toBe(webPlatform);
    expect(webPlatform.kind).toBe('web');
  });

  it('has the extension start no update flow of the app (D282)', () => {
    const monitor = { watch: vi.fn(), look: vi.fn() };
    extensionPlatform.startUpdates(monitor as never, idleHost(true).host);
    expect(extensionPlatform.kind).toBe('extension');
    expect(monitor.watch).not.toHaveBeenCalled();
    expect(monitor.look).not.toHaveBeenCalled();
  });

  it('registers no service worker outside the production build (D190)', () => {
    const register = vi.fn();
    vi.stubGlobal('navigator', { serviceWorker: { register } });
    webPlatform.startUpdates({ watch: vi.fn(), look: vi.fn() } as never, idleHost(true).host);
    expect(register).not.toHaveBeenCalled();
  });
});

describe('the page’s lock signals (D54, D151)', () => {
  it('reports the page hidden, and each change until unsubscribed', () => {
    const { doc } = page('visible');
    expect(pageLockSignals.hidden()).toBe(false);
    const seen: boolean[] = [];
    const stop = pageLockSignals.onHidden((hidden) => seen.push(hidden));
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(pageLockSignals.hidden()).toBe(true);
    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    stop();
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(seen).toEqual([true, false]);
  });

  it('counts input as activity until unsubscribed', () => {
    const { win } = page('visible');
    const activity = vi.fn();
    const stop = pageLockSignals.onActivity(activity);
    for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
      win.dispatchEvent(new Event(type));
    }
    win.dispatchEvent(new Event('scroll'));
    expect(activity).toHaveBeenCalledTimes(4);
    stop();
    win.dispatchEvent(new Event('keydown'));
    expect(activity).toHaveBeenCalledTimes(4);
  });

  it('knows no operating-system lock', () => {
    const lock = vi.fn();
    pageLockSignals.onSystemLock(lock)();
    expect(lock).not.toHaveBeenCalled();
  });
});

describe('the extension’s deferred update (extension.md §8.1)', () => {
  it('reloads at once when the vault is locked', () => {
    const r = runtime();
    deferUpdates(r.api, idleHost(true).host);
    expect(r.api.reload).not.toHaveBeenCalled();
    r.update();
    expect(r.api.reload).toHaveBeenCalledTimes(1);
  });

  it('waits while the vault is open, and reloads once when it locks', () => {
    const r = runtime();
    const h = idleHost(false);
    deferUpdates(r.api, h.host);
    r.update();
    h.changed();
    expect(r.api.reload).not.toHaveBeenCalled();
    h.state.idle = true;
    h.changed();
    h.changed();
    expect(r.api.reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload on a lock with no update', () => {
    const r = runtime();
    const h = idleHost(true);
    deferUpdates(r.api, h.host);
    h.changed();
    expect(r.api.reload).not.toHaveBeenCalled();
  });
});
