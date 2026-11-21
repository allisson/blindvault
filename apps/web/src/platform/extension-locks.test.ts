import { describe, expect, it, vi } from 'vitest';

import { type ExtensionApi, extensionClipboard, extensionLockSignals } from './extension-locks';

function listened<T extends unknown[]>() {
  const listeners = new Set<(...args: T) => void>();
  return {
    listeners,
    fire: (...args: T) => {
      for (const l of listeners) l(...args);
    },
    addListener: (l: (...args: T) => void) => listeners.add(l),
    removeListener: (l: (...args: T) => void) => listeners.delete(l),
  };
}

function api(focused = true) {
  const focus = listened<[number]>();
  const idle = listened<[string]>();
  const a = {
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: focus,
      getLastFocused: () => Promise.resolve({ focused }),
    },
    idle: { onStateChanged: idle },
    runtime: { sendMessage: vi.fn(() => Promise.resolve()) },
  } satisfies ExtensionApi;
  return { a, focus, idle };
}

function page() {
  const activity = listened<[]>();
  return {
    activity,
    signals: {
      onActivity: (l: () => void) => (activity.addListener(l), () => activity.removeListener(l)),
    },
  };
}

describe('the extension’s lock signals (extension.md §3.2, D284)', () => {
  it('counts the browser without focus as hidden, not the session host’s tab', () => {
    const { a, focus } = api();
    const s = extensionLockSignals(() => a, page().signals);
    const hidden = vi.fn();
    s.onHidden(hidden);
    expect(s.hidden()).toBe(false);
    focus.fire(-1);
    expect(s.hidden()).toBe(true);
    expect(hidden).toHaveBeenLastCalledWith(true);
    focus.fire(12);
    expect(s.hidden()).toBe(false);
    expect(hidden).toHaveBeenLastCalledWith(false);
    focus.fire(13);
    expect(hidden).toHaveBeenCalledTimes(2);
  });

  it('reads the focus the browser has at start', async () => {
    const { a } = api(false);
    const s = extensionLockSignals(() => a, page().signals);
    expect(s.hidden()).toBe(false);
    await vi.waitFor(() => {
      expect(s.hidden()).toBe(true);
    });
  });

  it('watches the focus once, however many listen', () => {
    const { a, focus } = api();
    const s = extensionLockSignals(() => a, page().signals);
    s.onHidden(() => undefined);
    s.onHidden(() => undefined);
    s.hidden();
    expect(focus.listeners.size).toBe(1);
  });

  it('locks on the operating system’s lock only', () => {
    const { a, idle } = api();
    const s = extensionLockSignals(() => a, page().signals);
    const locked = vi.fn();
    const stop = s.onSystemLock(locked);
    idle.fire('idle');
    idle.fire('active');
    expect(locked).not.toHaveBeenCalled();
    idle.fire('locked');
    expect(locked).toHaveBeenCalledTimes(1);
    stop();
    idle.fire('locked');
    expect(locked).toHaveBeenCalledTimes(1);
  });

  it('counts input in the page and the popup’s messages as activity', () => {
    const { a } = api();
    const p = page();
    const s = extensionLockSignals(() => a, p.signals);
    const active = vi.fn();
    const stop = s.onActivity(active);
    p.activity.fire();
    s.touch();
    expect(active).toHaveBeenCalledTimes(2);
    stop();
    p.activity.fire();
    s.touch();
    expect(active).toHaveBeenCalledTimes(2);
  });

  it('works outside an extension, as never hidden and never locked by the system', () => {
    const s = extensionLockSignals(() => undefined, page().signals);
    expect(s.hidden()).toBe(false);
    expect(() => {
      s.onSystemLock(() => undefined)();
    }).not.toThrow();
  });
});

describe('the extension’s clipboard (extension.md §6.3, D286)', () => {
  it('copies as a page does, and clears through the service worker', async () => {
    const { a } = api();
    const write = vi.fn(() => Promise.resolve());
    const c = extensionClipboard(() => a, write);
    await c.write('hunter2');
    expect(write).toHaveBeenCalledWith('hunter2');
    await c.write('');
    expect(write).toHaveBeenCalledTimes(1);
    expect(a.runtime.sendMessage).toHaveBeenCalledWith({
      v: 1,
      type: 'clipboard-clear',
      id: expect.any(Number) as unknown,
    });
  });

  it('never waits for the focus to clear', () => {
    const c = extensionClipboard(
      () => undefined,
      () => Promise.resolve(),
    );
    expect(c.hasFocus()).toBe(true);
  });
});
