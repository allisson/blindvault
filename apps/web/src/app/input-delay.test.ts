import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { INPUT_DELAY_MS, armAfterDelay } from './input-delay';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('armAfterDelay (extension.md §7.4, P-02)', () => {
  it('arms Confirm only after the delay, and again after each focus', () => {
    const target = new EventTarget();
    const states: boolean[] = [];
    const stop = armAfterDelay(target, (armed) => states.push(armed));
    expect(states).toEqual([false]);
    vi.advanceTimersByTime(INPUT_DELAY_MS - 1);
    expect(states).toEqual([false]);
    vi.advanceTimersByTime(1);
    expect(states).toEqual([false, true]);
    // A click aimed at the page lands in the window as it takes the focus: disarmed again.
    target.dispatchEvent(new Event('focus'));
    expect(states.at(-1)).toBe(false);
    vi.advanceTimersByTime(INPUT_DELAY_MS - 1);
    expect(states.at(-1)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(states.at(-1)).toBe(true);
    stop();
    target.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(INPUT_DELAY_MS);
    expect(states.at(-1)).toBe(true);
  });

  it('waits at least 500 ms', () => {
    expect(INPUT_DELAY_MS).toBeGreaterThanOrEqual(500);
  });
});
