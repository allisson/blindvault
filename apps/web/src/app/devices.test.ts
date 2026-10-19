import { type DeviceView, type SyncResult } from '@blindvault/vault';
import { describe, expect, it } from 'vitest';

import { devicesOf, eraseAdvice, lastSyncOf, peerSyncState, rejectedPeersOf } from './devices';

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

function session(
  devices: DeviceView[],
  lastSyncByPeer: [Uint8Array, number][] = [],
  retired = devices.some((d) => d.deviceId[0] === 1 && d.device.retired),
) {
  return {
    deviceId: OWN,
    registered: devices.some((d) => d.deviceId[0] === 1),
    retired,
    devices: () => devices,
    lastSyncByPeer,
  };
}

const id = (n: number) => new Uint8Array(16).fill(n);

// Only its kind and `live` matter here.
const RESULT = {} as SyncResult;

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

describe('the sync state for the UI (§13.2, D34, D216, D226)', () => {
  it('offers a sync only on a registered device whose own record is not retired (D113, D216)', () => {
    expect(devicesOf(session([view(1, false), view(2, false)])).syncs).toBe(true);
    // Unregistered: only re-admission (D113).
    expect(devicesOf(session([view(2, false)])).syncs).toBe(false);
    // Its own record retired (D41).
    expect(devicesOf(session([view(1, true), view(2, false)])).syncs).toBe(false);
    expect(devicesOf(session([view(1, false), view(2, false)], [], true)).syncs).toBe(false);
    // Every other record retired: no peer to sync with, but the retirement notice stays (D219).
    const s = devicesOf(session([view(1, false), view(2, true)]));
    expect(s.syncs).toBe(true);
    expect(s.listed.filter((d) => !d.own)).toEqual([]);
  });

  it('offers as peers only the Device records held, never this device nor a retired one', () => {
    const s = devicesOf(session([view(1, false), view(2, false), view(3, true)]));
    expect(s.listed.filter((d) => !d.own).map((d) => d.deviceId[0])).toEqual([2]);
  });

  it('gives the latest sync with any peer, named by its Device record, retired included', () => {
    const devices = [view(1, false), view(2, false, 'Phone'), view(3, true, 'Old laptop')];
    expect(
      lastSyncOf(
        session(devices, [
          [id(2), 10],
          [id(3), 30],
          [id(4), 20],
        ]),
      ),
    ).toEqual({ at: 30, name: 'Old laptop' });
    expect(lastSyncOf(session(devices, [[id(2), 10]]))).toEqual({ at: 10, name: 'Phone' });
  });

  it('gives the date alone for a peer whose Device record is not held, and nothing before any sync', () => {
    expect(lastSyncOf(session([view(1, false)], [[id(4), 20]]))).toEqual({ at: 20 });
    expect(lastSyncOf(session([view(1, false), view(2, false)]))).toBeUndefined();
  });

  it.each([
    [undefined, undefined],
    [{ kind: 'preparing' }, undefined],
    [{ kind: 'offer', text: 'x' }, undefined],
    [{ kind: 'scan' }, undefined],
    [{ kind: 'answer', text: 'x' }, undefined],
    [{ kind: 'failed', reason: 'ended' }, undefined],
    [{ kind: 'connecting' }, 'syncing'],
    [{ kind: 'connected' }, 'syncing'],
    [{ kind: 'synced', result: RESULT, live: false, unseen: false }, 'syncing'],
    [{ kind: 'synced', result: RESULT, live: true, unseen: false }, 'live'],
  ] as const)('shows the sync with the peer from %o as %s (D225)', (stage, state) => {
    expect(peerSyncState(stage)).toBe(state);
  });
});

describe('the incomplete-backup warning (D68, D115, D227)', () => {
  it('names each peer listed by its Device record, retired included, and gives none a name it lacks', () => {
    const s = {
      ...session([view(1, false), view(2, false, 'Phone'), view(3, true, 'Old laptop')]),
      rejectedPeers: [id(2), id(3), id(4)],
    };
    expect(rejectedPeersOf(s)).toEqual([
      { deviceId: id(2), name: 'Phone' },
      { deviceId: id(3), name: 'Old laptop' },
      { deviceId: id(4) },
    ]);
    expect(rejectedPeersOf({ ...s, rejectedPeers: [] })).toEqual([]);
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
