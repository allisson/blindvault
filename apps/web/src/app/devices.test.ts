import { type DeviceView } from '@blindvault/vault';
import { describe, expect, it } from 'vitest';

import { devicesOf } from './devices';

const OWN = new Uint8Array(16).fill(1);

function view(id: number, retired: boolean, displayName = `Device ${String(id)}`): DeviceView {
  return {
    deviceId: new Uint8Array(16).fill(id),
    hlc: { physicalMs: 0, counter: 0, deviceId: new Uint8Array(16) },
    device: { publicKey: new Uint8Array(32), displayName, retired, registeredAt: 0 },
    unknownKeys: [],
  };
}

function session(devices: DeviceView[]) {
  return {
    deviceId: OWN,
    registered: devices.some((d) => d.deviceId[0] === 1),
    devices: () => devices,
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
});
