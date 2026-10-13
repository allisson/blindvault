// What Settings shows of the Device records (§8.4, D30, D119, D186): the non-retired ones, this
// device's first, the count of retired ones, and the advice for an unregistered or only device.

import { type DeviceView } from '@blindvault/vault';

export interface ListedDevice extends DeviceView {
  /** This device's own record. */
  readonly own: boolean;
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
}

function sameId(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export function devicesOf(session: DeviceSource): Devices {
  const own = session.deviceId;
  const all = session.devices();
  const listed = all
    .filter((d) => !d.device.retired)
    .map((d) => ({ ...d, own: sameId(d.deviceId, own) }))
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
