import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LockTimers } from './lock-timers';

const PREFS = { autoLockMinutes: 5, hiddenLockSeconds: 60, clipboardClearSeconds: 30 };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function timers() {
  const lock = vi.fn();
  return { lock, t: new LockTimers(lock) };
}

describe('lock timers (overview §7, D54, D151)', () => {
  it('locks after the inactivity time, restarted by activity', () => {
    const { lock, t } = timers();
    t.start(PREFS, false);
    vi.advanceTimersByTime(4 * 60_000);
    t.activity();
    vi.advanceTimersByTime(4 * 60_000);
    expect(lock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(lock).toHaveBeenCalledTimes(1);
  });

  it('locks after the app is hidden for the configured time, cleared when visible', () => {
    const { lock, t } = timers();
    t.start(PREFS, false);
    t.visibility(true);
    vi.advanceTimersByTime(59_000);
    t.visibility(false);
    vi.advanceTimersByTime(59_000);
    expect(lock).not.toHaveBeenCalled();
    t.visibility(true);
    vi.advanceTimersByTime(60_000);
    expect(lock).toHaveBeenCalledTimes(1);
  });

  it('keeps the inactivity timer running while hidden, independently', () => {
    const { lock, t } = timers();
    t.start({ ...PREFS, autoLockMinutes: 1, hiddenLockSeconds: 900 }, false);
    t.visibility(true);
    vi.advanceTimersByTime(60_000);
    expect(lock).toHaveBeenCalledTimes(1);
  });

  it('locks at once when hidden with 0, also when started hidden', () => {
    const { lock, t } = timers();
    t.start({ ...PREFS, hiddenLockSeconds: 0 }, true);
    expect(lock).toHaveBeenCalledTimes(1);
    t.start({ ...PREFS, hiddenLockSeconds: 0 }, false);
    t.visibility(true);
    expect(lock).toHaveBeenCalledTimes(2);
  });

  it('fires once, and does nothing after stop or before start', () => {
    const { lock, t } = timers();
    t.activity();
    t.visibility(true);
    vi.advanceTimersByTime(3_600_000);
    expect(lock).not.toHaveBeenCalled();
    t.start(PREFS, false);
    t.stop();
    vi.advanceTimersByTime(3_600_000);
    expect(lock).not.toHaveBeenCalled();
    t.start(PREFS, false);
    t.visibility(true);
    vi.advanceTimersByTime(3_600_000);
    expect(lock).toHaveBeenCalledTimes(1);
  });
});
