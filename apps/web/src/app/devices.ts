// What Settings shows of the Device records (§8.4, D30, D34, D119, D186): the non-retired ones, this
// device's first, with the last completed sync with each, the retired ones, which can be told they
// are retired (D219), and the advice for an unregistered or only device; the sync state: the latest
// sync with any peer, and the open sync on its peer's row (§13.2, D226).

import { type DeviceView } from '@blindvault/vault';

import { type SyncStage } from './sync';

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
  /**
   * A sync is offered with each other listed record, and a retirement notice with each retired one:
   * this device holds its own Device record, not retired (D41, D113, D216, D219).
   */
  readonly syncs: boolean;
  readonly listed: readonly ListedDevice[];
  /** The retired Device records, by name. */
  readonly retired: readonly DeviceView[];
  readonly retiredCount: number;
  readonly advice: DeviceAdvice | undefined;
}

export interface DeviceSource {
  readonly deviceId: Uint8Array;
  readonly registered: boolean;
  /** This device's own Device record is retired (D41). */
  readonly retired: boolean;
  devices(): readonly DeviceView[];
  readonly lastSyncByPeer: readonly (readonly [Uint8Array, number])[];
}

function sameId(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export function devicesOf(session: DeviceSource): Devices {
  const own = session.deviceId;
  const all = session.devices();
  const byName = (a: DeviceView, b: DeviceView) =>
    a.device.displayName.localeCompare(b.device.displayName, undefined, { sensitivity: 'base' });
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
    .sort((a, b) => Number(b.own) - Number(a.own) || byName(a, b));
  const retired = all.filter((d) => d.device.retired).sort(byName);
  const others = listed.some((d) => !d.own);
  const { registered } = session;
  return {
    registered,
    syncs: registered && !session.retired,
    listed,
    retired,
    retiredCount: retired.length,
    advice: !others ? 'only-device' : registered ? undefined : 'readmit',
  };
}

/**
 * What an erase says of this device's Device record (§7, D41, D183, D205): its name, to retire from
 * another device; none to retire on the only device (D119), on an unregistered device or once its
 * own record is retired; or, while locked (`undefined`), that its name cannot be shown.
 */
export type EraseAdvice =
  | { readonly kind: 'named'; readonly name: string }
  | { readonly kind: 'only-device' | 'unregistered' | 'locked' };

export function eraseAdvice(devices: Devices | undefined): EraseAdvice {
  if (!devices) return { kind: 'locked' };
  if (devices.advice === 'only-device') return { kind: 'only-device' };
  const own = devices.listed.find((d) => d.own);
  return own ? { kind: 'named', name: own.device.displayName } : { kind: 'unregistered' };
}

/** The latest completed sync with any peer, named by its Device record when held, retired or not. */
export interface LastSync {
  readonly at: number;
  readonly name?: string;
}

export function lastSyncOf(session: DeviceSource): LastSync | undefined {
  let latest: readonly [Uint8Array, number] | undefined;
  for (const pair of session.lastSyncByPeer) if (!latest || pair[1] > latest[1]) latest = pair;
  if (!latest) return undefined;
  const [peer, at] = latest;
  const name = session.devices().find((d) => sameId(d.deviceId, peer))?.device.displayName;
  return name === undefined ? { at } : { at, name };
}

/**
 * What the peer's row says of the sync with it (D225, D226): `syncing` once the connection opens
 * until both committed, `live` after; nothing while the codes are exchanged or once it ended.
 */
export type PeerSyncState = 'syncing' | 'live';

export function peerSyncState(stage: SyncStage | undefined): PeerSyncState | undefined {
  switch (stage?.kind) {
    case 'connecting':
    case 'connected':
      return 'syncing';
    case 'synced':
      return stage.live ? 'live' : 'syncing';
    default:
      return undefined;
  }
}
