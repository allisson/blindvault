import { type DeviceView, FUTURE_CLOCK_BOUND_MS } from '@blindvault/vault';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAX_TIMEOUT_MS, WritableTimer, clockNoticeOf } from './clock';

const T0 = 1_760_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const OWN = new Uint8Array(16).fill(1);
const OTHER = new Uint8Array(16).fill(2);

function device(id: Uint8Array, retired = false): DeviceView {
  return {
    deviceId: id,
    hlc: { physicalMs: T0, counter: 0, deviceId: OWN },
    device: { publicKey: new Uint8Array(32), displayName: 'Phone', retired, registeredAt: T0 },
    unknownKeys: [],
  };
}

function source(
  writableAt: number | null,
  others: readonly (readonly [Uint8Array, boolean])[] = [],
) {
  return {
    writableAt,
    deviceId: OWN,
    registered: true,
    devices: () => [device(OWN), ...others.map(([id, retired]) => device(id, retired))],
    lastSyncByPeer: [],
  };
}

describe('clock gone back (§9.2, D73, D149, D221)', () => {
  it('says nothing while the vault is writable', () => {
    expect(clockNoticeOf(source(null), T0)).toBeUndefined();
  });

  it('says when writing resumes', () => {
    expect(clockNoticeOf(source(T0 + DAY), T0)).toEqual({
      until: T0 + DAY,
      far: false,
      pairAgain: false,
    });
  });

  it('offers the ways out only when writing resumes more than the future-clock bound later (D149)', () => {
    const others = [[OTHER, false]] as const;
    expect(clockNoticeOf(source(T0 + FUTURE_CLOCK_BOUND_MS, others), T0)).toEqual({
      until: T0 + FUTURE_CLOCK_BOUND_MS,
      far: false,
      pairAgain: false,
    });
    expect(clockNoticeOf(source(T0 + FUTURE_CLOCK_BOUND_MS + 1, others), T0)).toEqual({
      until: T0 + FUTURE_CLOCK_BOUND_MS + 1,
      far: true,
      pairAgain: true,
    });
  });

  it('offers pairing again only when another device not retired exists (D149, D153)', () => {
    const until = T0 + 400 * DAY;
    expect(clockNoticeOf(source(until), T0)?.pairAgain).toBe(false);
    expect(clockNoticeOf(source(until, [[OTHER, true]]), T0)?.pairAgain).toBe(false);
    expect(clockNoticeOf(source(until, [[OTHER, false]]), T0)?.pairAgain).toBe(true);
  });
});

describe('writable timer (D73, D221)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function timer() {
    vi.useFakeTimers({ now: T0 });
    const reached = vi.fn();
    return { timer: new WritableTimer(() => Date.now(), reached), reached };
  }

  it('calls back once the clock reaches the moment, not a millisecond before', () => {
    const { timer: t, reached } = timer();
    t.set(T0 + DAY);
    vi.advanceTimersByTime(DAY - 1);
    expect(reached).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reached).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(400 * DAY);
    expect(reached).toHaveBeenCalledTimes(1);
  });

  it('waits past the setTimeout limit in steps', () => {
    const { timer: t, reached } = timer();
    expect(MAX_TIMEOUT_MS).toBe(2 ** 31 - 1);
    const at = T0 + 400 * DAY;
    t.set(at);
    vi.advanceTimersByTime(at - T0 - 1);
    expect(reached).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reached).toHaveBeenCalledTimes(1);
  });

  it('is replaced by a later set and cleared by a null one', () => {
    const { timer: t, reached } = timer();
    t.set(T0 + DAY);
    t.set(T0 + 2 * DAY);
    vi.advanceTimersByTime(DAY);
    expect(reached).not.toHaveBeenCalled();
    t.set(null);
    vi.advanceTimersByTime(400 * DAY);
    expect(reached).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
