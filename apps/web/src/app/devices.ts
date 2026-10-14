// What Settings shows of the Device records (§8.4, D30, D34, D119, D186): the non-retired ones, this
// device's first, with the last completed sync with each, the count of retired ones, and the advice
// for an unregistered or only device.

import { type DeviceView } from '@blindvault/vault';

export interface ListedDevice extends DeviceView {
  /** This device's own record. */
  readonly own: boolean;
  /** The last completed sync with that device (Unix ms), if any (D34). */
  readonly lastSyncAt?: number;
  /**
   * A pairing not completed: this device wrote the record, and no sync with it was ever completed,
   * so its commit acknowledgement never came (D33, D34, D203).
   */
  readonly pending: boolean;
}

/**
 * `readmit`: this device holds no Device record of its own and another non-retired one exists, so
 * it exchanges data only through backups until re-admission (D22, D113). `only-device`: no other
 * non-retired record exists, registered or not (D119).
 */
export type DeviceAdvice = 'readmit' | 'only-device';

export interface Devices {
  readonly registered: boolean;
  readonly listed: readonly ListedDevice[];
  readonly retiredCount: number;
  readonly advice: DeviceAdvice | undefined;
}

interface DeviceSource {
  readonly deviceId: Uint8Array;
  readonly registered: boolean;
  devices(): readonly DeviceView[];
  readonly lastSyncByPeer: readonly (readonly [Uint8Array, number])[];
}

function sameId(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export function devicesOf(session: DeviceSource): Devices {
  const own = session.deviceId;
  const all = session.devices();
  const listed = all
    .filter((d) => !d.device.retired)
    .map((d) => {
      const self = sameId(d.deviceId, own);
      const lastSyncAt = session.lastSyncByPeer.find(([id]) => sameId(id, d.deviceId))?.[1];
      return {
        ...d,
        own: self,
        ...(lastSyncAt !== undefined ? { lastSyncAt } : {}),
        pending: !self && lastSyncAt === undefined && sameId(d.hlc.deviceId, own),
      };
    })
    .sort(
      (a, b) =>
        Number(b.own) - Number(a.own) ||
        a.device.displayName.localeCompare(b.device.displayName, undefined, {
          sensitivity: 'base',
        }),
    );
  const others = listed.some((d) => !d.own);
  const { registered } = session;
  return {
    registered,
    listed,
    retiredCount: all.length - listed.length,
    advice: !others ? 'only-device' : registered ? undefined : 'readmit',
  };
}
