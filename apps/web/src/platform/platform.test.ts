import { afterEach, describe, expect, it, vi } from 'vitest';

import { extensionPlatform } from './extension';
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

describe('the platform (extension.md §2)', () => {
  it('is the web one outside an extension build', () => {
    expect(platform).toBe(webPlatform);
    expect(webPlatform.kind).toBe('web');
  });

  it('has the extension start no update flow of the app (D282)', () => {
    const monitor = { watch: vi.fn(), look: vi.fn() };
    extensionPlatform.startUpdates(monitor as never);
    expect(extensionPlatform.kind).toBe('extension');
    expect(monitor.watch).not.toHaveBeenCalled();
    expect(monitor.look).not.toHaveBeenCalled();
  });

  it('registers no service worker outside the production build (D190)', () => {
    const register = vi.fn();
    vi.stubGlobal('navigator', { serviceWorker: { register } });
    webPlatform.startUpdates({ watch: vi.fn(), look: vi.fn() } as never);
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
