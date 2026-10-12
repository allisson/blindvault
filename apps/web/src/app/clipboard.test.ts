import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClipboardGuard, type ClipboardPort } from './clipboard';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function guard(focused = true) {
  const writes: string[] = [];
  const listeners = new Set<() => void>();
  const state = { focused, failWrite: false };
  const port: ClipboardPort = {
    write: (text) => {
      if (state.failWrite) return Promise.reject(new Error('denied'));
      writes.push(text);
      return Promise.resolve();
    },
    hasFocus: () => state.focused,
    onFocus: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const focus = () => {
    state.focused = true;
    for (const l of [...listeners]) l();
  };
  return { writes, state, focus, listeners, g: new ClipboardGuard(port) };
}

describe('clipboard clear (D54, D127, D151)', () => {
  it('clears the clipboard once the timeout passes while the app has focus', async () => {
    const { writes, g } = guard();
    await g.copy('s3cret', 30);
    expect(writes).toEqual(['s3cret']);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(writes).toEqual(['s3cret']);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toEqual(['s3cret', '']);
  });

  it('waits for focus when the timeout passes in the background', async () => {
    const { writes, state, focus, listeners, g } = guard();
    await g.copy('s3cret', 10);
    state.focused = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(writes).toEqual(['s3cret']);
    focus();
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toEqual(['s3cret', '']);
    // Cleared once: nothing still waits for focus.
    expect(listeners.size).toBe(0);
  });

  it('restarts the timeout for a new copy and clears only once', async () => {
    const { writes, g } = guard();
    await g.copy('first', 30);
    await vi.advanceTimersByTimeAsync(20_000);
    await g.copy('second', 30);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(writes).toEqual(['first', 'second']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(writes).toEqual(['first', 'second', '']);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(writes).toEqual(['first', 'second', '']);
  });

  it('clears at once on lock, and waits for focus if the lock came in the background', async () => {
    const { writes, state, focus, g } = guard();
    await g.copy('s3cret', 120);
    g.lock();
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toEqual(['s3cret', '']);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(writes).toEqual(['s3cret', '']);

    await g.copy('again', 120);
    state.focused = false;
    g.lock();
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toEqual(['s3cret', '', 'again']);
    focus();
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toEqual(['s3cret', '', 'again', '']);
  });

  it('writes nothing on lock when nothing was copied', async () => {
    const { writes, g } = guard();
    g.lock();
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toEqual([]);
  });

  it('reports a failed copy and schedules no clear', async () => {
    const { writes, state, g } = guard();
    state.failWrite = true;
    await expect(g.copy('s3cret', 30)).rejects.toThrow('denied');
    state.failWrite = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(writes).toEqual([]);
  });

  it('swallows a failed clear: clearing is not guaranteed', async () => {
    const { state, g } = guard();
    await g.copy('s3cret', 10);
    state.failWrite = true;
    await vi.advanceTimersByTimeAsync(10_000);
    // No unhandled rejection; a later copy still works.
    state.failWrite = false;
    await expect(g.copy('next', 10)).resolves.toBeUndefined();
  });

  it.each([0, 9, 121, 10.5, Number.NaN])(
    'refuses a clear timeout of %s s, outside 10–120 (D151)',
    async (seconds) => {
      const { writes, g } = guard();
      await expect(g.copy('s3cret', seconds)).rejects.toThrow(RangeError);
      expect(writes).toEqual([]);
    },
  );
});
