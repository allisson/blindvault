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

  it('pauses the inactivity lock while a Recovery Phrase is shown, never the hidden-app lock (D104)', () => {
    const { lock, t } = timers();
    t.start(PREFS, false);
    t.pause();
    t.activity();
    vi.advanceTimersByTime(60 * 60_000);
    expect(lock).not.toHaveBeenCalled();
    // A restart with new preferences keeps the pause.
    t.start(PREFS, false);
    vi.advanceTimersByTime(60 * 60_000);
    expect(lock).not.toHaveBeenCalled();
    t.visibility(true);
    vi.advanceTimersByTime(60_000);
    expect(lock).toHaveBeenCalledTimes(1);
  });

  it('restarts the inactivity time on resume, and a stop ends the pause', () => {
    const { lock, t } = timers();
    t.start(PREFS, false);
    t.pause();
    vi.advanceTimersByTime(10 * 60_000);
    t.resume();
    vi.advanceTimersByTime(5 * 60_000 - 1);
    expect(lock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(lock).toHaveBeenCalledTimes(1);
    t.pause();
    t.stop();
    t.start(PREFS, false);
    vi.advanceTimersByTime(5 * 60_000);
    expect(lock).toHaveBeenCalledTimes(2);
  });

  // The wall clock moves while no timer runs: a frozen page or a suspended device (D263).
  it('locks at the next activity once the inactivity time passed by the wall clock', () => {
    const { lock, t } = timers();
    t.start(PREFS, false);
    vi.setSystemTime(Date.now() + 4 * 60_000);
    t.activity();
    expect(lock).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 5 * 60_000);
    t.activity();
    expect(lock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3_600_000);
    expect(lock).toHaveBeenCalledTimes(1);
  });

  it('locks when visible again once the hidden time passed by the wall clock', () => {
    const { lock, t } = timers();
    t.start({ ...PREFS, autoLockMinutes: 60 }, false);
    t.visibility(true);
    vi.setSystemTime(Date.now() + 59_000);
    t.visibility(false);
    expect(lock).not.toHaveBeenCalled();
    t.visibility(true);
    vi.setSystemTime(Date.now() + 60_000);
    t.visibility(false);
    expect(lock).toHaveBeenCalledTimes(1);
  });

  it('keeps no deadline while paused, and none after stop', () => {
    const { lock, t } = timers();
    t.start(PREFS, false);
    t.pause();
    vi.setSystemTime(Date.now() + 60 * 60_000);
    t.activity();
    expect(lock).not.toHaveBeenCalled();
    t.stop();
    t.start(PREFS, false);
    t.visibility(true);
    t.stop();
    vi.setSystemTime(Date.now() + 60 * 60_000);
    t.activity();
    t.visibility(false);
    expect(lock).not.toHaveBeenCalled();
  });
});
