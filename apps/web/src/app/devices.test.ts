import { type DeviceView } from '@blindvault/vault';
import { describe, expect, it } from 'vitest';

import { devicesOf, eraseAdvice } from './devices';

const OWN = new Uint8Array(16).fill(1);

function view(
  id: number,
  retired: boolean,
  displayName = `Device ${String(id)}`,
  writer = new Uint8Array(16),
): DeviceView {
  return {
    deviceId: new Uint8Array(16).fill(id),
    hlc: { physicalMs: 0, counter: 0, deviceId: writer },
    device: { publicKey: new Uint8Array(32), displayName, retired, registeredAt: 0 },
    unknownKeys: [],
  };
}

function session(devices: DeviceView[], lastSyncByPeer: [Uint8Array, number][] = []) {
  return {
    deviceId: OWN,
    registered: devices.some((d) => d.deviceId[0] === 1),
    devices: () => devices,
    lastSyncByPeer,
  };
}

describe('devices for the UI (§8.4, D30, D119, D186)', () => {
  it('lists the non-retired records, own first, then by name, and counts the retired', () => {
    const s = devicesOf(
      session([view(3, false, 'Zebra'), view(2, true), view(1, false), view(4, false, 'apple')]),
    );
    expect(s.registered).toBe(true);
    expect(s.listed.map((d) => [d.deviceId[0], d.own])).toEqual([
      [1, true],
      [4, false],
      [3, false],
    ]);
    expect(s.retiredCount).toBe(1);
    expect(s.advice).toBeUndefined();
  });

  it('recommends re-admission on an unregistered device while another non-retired record exists (D22, D113)', () => {
    const s = devicesOf(session([view(2, false), view(3, true)]));
    expect(s.registered).toBe(false);
    expect(s.listed.map((d) => d.own)).toEqual([false]);
    expect(s.advice).toBe('readmit');
  });

  it('says the device is the only one when every other record is retired, registered or not (D119)', () => {
    expect(devicesOf(session([view(2, true)])).advice).toBe('only-device');
    expect(devicesOf(session([])).advice).toBe('only-device');
    expect(devicesOf(session([view(1, false), view(2, true)])).advice).toBe('only-device');
  });

  it('gives the last completed sync with each other device, none for this one (D34)', () => {
    const s = devicesOf(
      session([view(1, false), view(2, false), view(3, false)], [[new Uint8Array(16).fill(2), 42]]),
    );
    expect(s.listed.map((d) => [d.deviceId[0], d.lastSyncAt])).toEqual([
      [1, undefined],
      [2, 42],
      [3, undefined],
    ]);
  });

  it('marks a record this device wrote, with no sync since, as a pairing not completed (D34, D203)', () => {
    const s = devicesOf(
      session(
        [view(1, false), view(2, false, 'B', OWN), view(3, false, 'C', OWN), view(4, false)],
        [[new Uint8Array(16).fill(3), 42]],
      ),
    );
    expect(s.listed.map((d) => [d.deviceId[0], d.pending])).toEqual([
      [1, false],
      [2, true],
      [3, false],
      [4, false],
    ]);
    // This device's own record, written by itself at creation, is never pending.
    expect(devicesOf(session([view(1, false, 'A', OWN)])).listed[0]?.pending).toBe(false);
  });
});

describe('the Device record advice of an erase (§7, D41, D119, D183, D205)', () => {
  it("names this device's record while another non-retired one exists", () => {
    expect(eraseAdvice(devicesOf(session([view(1, false, 'Laptop'), view(2, false)])))).toEqual({
      kind: 'named',
      name: 'Laptop',
    });
  });

  it('says the device is the only one before anything else, registered or not (D119)', () => {
    expect(eraseAdvice(devicesOf(session([view(1, false), view(2, true)])))).toEqual({
      kind: 'only-device',
    });
    expect(eraseAdvice(devicesOf(session([])))).toEqual({ kind: 'only-device' });
  });

  it('has no record to retire on an unregistered device, nor once its own record is retired (D41)', () => {
    expect(eraseAdvice(devicesOf(session([view(2, false)])))).toEqual({ kind: 'unregistered' });
    expect(eraseAdvice(devicesOf(session([view(1, true), view(2, false)])))).toEqual({
      kind: 'unregistered',
    });
  });

  it('cannot name it while locked (D183)', () => {
    expect(eraseAdvice(undefined)).toEqual({ kind: 'locked' });
  });
});
