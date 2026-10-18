import { describe, expect, it } from 'vitest';

import { ContentInvalidError, HlcReadOnlyError } from './errors';
import { FUTURE_CLOCK_BOUND_MS, HlcClock, checkHlc, compareHlc } from './hlc';

const ME = new Uint8Array(16).fill(1);
const PEER = new Uint8Array(16).fill(2);
const DAY = FUTURE_CLOCK_BOUND_MS;

function clockAt(start: number) {
  const time = { now: start };
  return { time, now: () => time.now };
}

describe('HLC order (D19)', () => {
  it('compares physicalMs, then counter, then deviceId bytewise', () => {
    const a = { physicalMs: 1, counter: 9, deviceId: PEER };
    expect(compareHlc(a, { physicalMs: 2, counter: 0, deviceId: ME })).toBe(-1);
    expect(compareHlc(a, { physicalMs: 1, counter: 8, deviceId: PEER })).toBe(1);
    expect(compareHlc(a, { physicalMs: 1, counter: 9, deviceId: ME })).toBe(1);
    expect(compareHlc(a, { ...a, deviceId: PEER.slice() })).toBe(0);
  });

  it.each([
    ['negative physicalMs', { physicalMs: -1, counter: 0, deviceId: ME }],
    ['physicalMs beyond 2^53 − 1', { physicalMs: 2 ** 53, counter: 0, deviceId: ME }],
    ['counter beyond 2^32 − 1', { physicalMs: 0, counter: 2 ** 32, deviceId: ME }],
    ['fractional counter', { physicalMs: 0, counter: 0.5, deviceId: ME }],
    ['short deviceId', { physicalMs: 0, counter: 0, deviceId: new Uint8Array(15) }],
  ])('rejects %s', (_name, hlc) => {
    expect(() => {
      checkHlc(hlc);
    }).toThrow(ContentInvalidError);
  });
});

describe('HLC issue (CRYPTO-INV-020)', () => {
  it('is strictly monotonic, also when the physical clock stalls or goes back a little', () => {
    const { time, now } = clockAt(1000);
    const clock = HlcClock.create(ME, now);
    const issued = [clock.issue()];
    time.now = 1000;
    issued.push(clock.issue());
    time.now = 900;
    issued.push(clock.issue());
    time.now = 2000;
    issued.push(clock.issue());
    issued.reduce((previous, next) => {
      expect(compareHlc(previous, next)).toBe(-1);
      return next;
    });
    expect(issued.map((h) => [h.physicalMs, h.counter])).toEqual([
      [1000, 1],
      [1000, 2],
      [1000, 3],
      [2000, 0],
    ]);
    expect(issued.every((h) => h.deviceId.every((b) => b === 1))).toBe(true);
  });

  it('issues above the record it replaces (D109)', () => {
    const { now } = clockAt(1000);
    const clock = HlcClock.create(ME, now);
    const replaced = { physicalMs: 5000, counter: 3, deviceId: PEER };
    const next = clock.issue(replaced);
    expect(compareHlc(next, replaced)).toBe(1);
    expect([next.physicalMs, next.counter]).toEqual([5000, 4]);
  });

  it('carries a full counter into physicalMs', () => {
    const { now } = clockAt(1000);
    const clock = HlcClock.resume(
      ME,
      { physicalMs: 1000, counter: 2 ** 32 - 1, deviceId: ME },
      [],
      now,
    );
    expect(clock.issue()).toMatchObject({ physicalMs: 1001, counter: 0 });
  });

  it('becomes read-only, issuing nothing, while the state is beyond the cap (D73)', () => {
    const { time, now } = clockAt(1000);
    const stored = { physicalMs: 1000 + DAY + 1, counter: 0, deviceId: ME };
    const clock = HlcClock.resume(ME, stored, [], now);
    expect(clock.writable).toBe(false);
    expect(clock.writableAt).toBe(1001);
    expect(() => clock.issue()).toThrow(HlcReadOnlyError);
    expect(clock.state).toEqual(stored);
    time.now = 1001;
    expect(clock.writable).toBe(true);
    expect(clock.writableAt).toBeNull();
    expect(compareHlc(clock.issue(), stored)).toBe(1);
  });

  it('refuses to issue above a replaced record beyond the cap', () => {
    const { now } = clockAt(1000);
    const clock = HlcClock.create(ME, now);
    const ahead = { physicalMs: 1000 + DAY + 5, counter: 0, deviceId: PEER };
    expect(() => clock.issue(ahead)).toThrow(HlcReadOnlyError);
    expect(clock.state.physicalMs).toBe(1000);
  });

  it('issues a retirement even beyond the cap, still monotonic (D85)', () => {
    const { now } = clockAt(1000);
    const stored = { physicalMs: 1000 + 10 * DAY, counter: 7, deviceId: PEER };
    const clock = HlcClock.resume(ME, stored, [], now);
    const retirement = clock.issueRetirement();
    expect(retirement).toEqual({ physicalMs: stored.physicalMs, counter: 8, deviceId: ME });
    expect(compareHlc(retirement, stored)).toBe(1);
    const full = HlcClock.resume(ME, { ...stored, counter: 2 ** 32 - 1 }, [], now);
    expect(full.issueRetirement()).toMatchObject({ physicalMs: stored.physicalMs + 1, counter: 0 });
  });

  it('copies state so callers cannot change it', () => {
    const { now } = clockAt(1000);
    const clock = HlcClock.create(ME, now);
    const issued = clock.issue();
    issued.deviceId.fill(9);
    clock.state.deviceId.fill(9);
    expect(clock.state.deviceId).toEqual(ME);
  });
});

describe('HLC receive and resume (D62, D109)', () => {
  it('advances the state to an accepted record, so the next write wins LWW over it', () => {
    const { now } = clockAt(1000);
    const clock = HlcClock.create(ME, now);
    const received = { physicalMs: 50_000, counter: 2, deviceId: PEER };
    clock.receive(received);
    expect(clock.state).toEqual(received);
    expect(compareHlc(clock.issue(), received)).toBe(1);
    clock.receive({ physicalMs: 10, counter: 0, deviceId: PEER });
    expect(clock.state.physicalMs).toBe(50_000);
  });

  it('does not advance past the cap for a record beyond the bound', () => {
    const { now } = clockAt(1000);
    const clock = HlcClock.create(ME, now);
    const ahead = { physicalMs: 1000 + DAY + 1, counter: 0, deviceId: PEER };
    expect(clock.beyondBound(ahead)).toBe(true);
    clock.receive(ahead);
    expect(clock.state.physicalMs).toBe(1000);
    expect(clock.beyondBound({ ...ahead, physicalMs: 1000 + DAY })).toBe(false);
  });

  it('resumes from the greater of the stored state and the greatest held hlc', () => {
    const { now } = clockAt(1000);
    const stored = { physicalMs: 2000, counter: 0, deviceId: ME };
    const held = [
      { physicalMs: 3000, counter: 1, deviceId: PEER },
      { physicalMs: 1000 + DAY + 9, counter: 0, deviceId: PEER },
    ];
    expect(HlcClock.resume(ME, stored, held, now).state).toEqual(held[0]);
    expect(HlcClock.resume(ME, stored, [], now).state).toEqual(stored);
  });

  it('rejects a malformed stored or received hlc', () => {
    const { now } = clockAt(1000);
    const bad = { physicalMs: 1, counter: -1, deviceId: ME };
    expect(() => HlcClock.resume(ME, bad, [], now)).toThrow(ContentInvalidError);
    expect(() => {
      HlcClock.create(ME, now).receive(bad);
    }).toThrow(ContentInvalidError);
    expect(() => HlcClock.create(ME, now).issue(bad)).toThrow(ContentInvalidError);
    expect(() => HlcClock.create(new Uint8Array(3), now)).toThrow(ContentInvalidError);
  });
});

describe('issued HLCs (D225)', () => {
  it('counts the HLCs issued, a retirement included, and not those received', () => {
    const clock = HlcClock.create(new Uint8Array(16).fill(1), () => 1_760_000_000_000);
    expect(clock.issued).toBe(0);
    clock.issue();
    clock.receive({
      physicalMs: 1_760_000_000_500,
      counter: 0,
      deviceId: new Uint8Array(16).fill(2),
    });
    expect(clock.issued).toBe(1);
    clock.issueRetirement();
    expect(clock.issued).toBe(2);
  });
});
