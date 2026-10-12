// Local Config content (record-content.md §9, D58, D121, D151, D164, D170). An invalid value makes
// unlock refuse the Local Config as corrupt; an unknown format version asks for an app update.

import {
  type CborMap,
  type CborValue,
  type Hlc,
  type Sealed,
  decodeCbor,
} from '@blindvault/crypto';

import { ContentInvalidError } from './errors';
import { checkHlc } from './hlc';
import { compareBytes, isBytes, isId, isTextKeyed, isUint, uintIn } from './text';

export const LOCAL_CONFIG_FORMAT_VERSION = 1;

/** Thrown for a `localConfigFormatVersion` this app does not know (D164). */
export class UnsupportedLocalConfigError extends ContentInvalidError {
  override name = 'UnsupportedLocalConfigError';
  constructor() {
    super('localConfigFormatVersion');
  }
}

export interface LocalConfigCleartext {
  readonly vaultId: Uint8Array;
  readonly localConfigId: Uint8Array;
  readonly kek: {
    readonly salt: Uint8Array;
    readonly opslimit: number;
    readonly memlimit: number;
    readonly mkWrap: Sealed;
  };
  readonly prf?: {
    readonly credentialId: Uint8Array;
    readonly prfInput: Uint8Array;
    readonly mkWrap: Sealed;
  };
  readonly replacesVaultId?: Uint8Array;
  readonly encrypted: Sealed;
}

export interface Preferences {
  readonly autoLockMinutes: number;
  readonly hiddenLockSeconds: number;
  readonly clipboardClearSeconds: number;
}

export const PREFERENCE_RANGES = {
  autoLockMinutes: [1, 60],
  hiddenLockSeconds: [0, 900],
  clipboardClearSeconds: [10, 120],
} as const;

export const DEFAULT_PREFERENCES: Preferences = {
  autoLockMinutes: 5,
  hiddenLockSeconds: 60,
  clipboardClearSeconds: 30,
};

/** The encrypted part without its device identity, which only `packages/crypto` reads as bytes. */
export interface LocalConfigState {
  readonly preferences: Preferences;
  readonly hlc: Hlc;
  readonly lastBackupAt?: number | bigint;
  readonly lastPhraseId?: Uint8Array;
  readonly lastSyncByPeer?: readonly (readonly [Uint8Array, number | bigint])[];
  readonly seenDevices?: readonly Uint8Array[];
  readonly seenRetiredDevices?: readonly Uint8Array[];
  readonly rejectedPeers?: readonly Uint8Array[];
}

export interface LocalConfigEncrypted extends LocalConfigState {
  readonly deviceIdentity: { readonly publicKey: Uint8Array; readonly privateKey: Uint8Array };
}

function check(condition: boolean, what: string): asserts condition {
  if (!condition) throw new ContentInvalidError(what);
}

function exactKeys(map: CborMap, keys: readonly string[]): boolean {
  return map.size === keys.length && keys.every((k) => map.has(k));
}

function onlyKeys(map: CborMap, keys: readonly string[]): boolean {
  return [...map.keys()].every((k) => typeof k === 'string' && keys.includes(k));
}

function sealed(value: CborValue | undefined, length?: number): Sealed {
  check(isTextKeyed(value) && exactKeys(value, ['n', 'c']), 'sealed');
  const n = value.get('n');
  const c = value.get('c');
  check(isBytes(n, 24) && c instanceof Uint8Array, 'sealed');
  check(length === undefined ? c.length >= 16 : c.length === length, 'sealed');
  return { n, c };
}

const WRAP_LENGTH = 48;

/** The cleartext part, read before unlock. */
export function readLocalConfig(value: CborValue): LocalConfigCleartext {
  check(isTextKeyed(value), 'local config');
  const version = value.get('localConfigFormatVersion');
  check(isUint(version), 'localConfigFormatVersion');
  if (version !== LOCAL_CONFIG_FORMAT_VERSION) throw new UnsupportedLocalConfigError();
  check(
    onlyKeys(value, [
      'localConfigFormatVersion',
      'vaultId',
      'localConfigId',
      'kek',
      'prf',
      'replacesVaultId',
      'encrypted',
    ]),
    'unknown key',
  );
  const vaultId = value.get('vaultId');
  const localConfigId = value.get('localConfigId');
  check(isId(vaultId) && isId(localConfigId), 'id');
  const kek = value.get('kek');
  check(isTextKeyed(kek) && exactKeys(kek, ['salt', 'opslimit', 'memlimit', 'mkWrap']), 'kek');
  const salt = kek.get('salt');
  const opslimit = kek.get('opslimit');
  const memlimit = kek.get('memlimit');
  check(isBytes(salt, 16), 'salt');
  check(typeof opslimit === 'number' && isUint(opslimit), 'opslimit');
  check(typeof memlimit === 'number' && isUint(memlimit), 'memlimit');
  const out: {
    -readonly [K in keyof LocalConfigCleartext]: LocalConfigCleartext[K];
  } = {
    vaultId,
    localConfigId,
    kek: { salt, opslimit, memlimit, mkWrap: sealed(kek.get('mkWrap'), WRAP_LENGTH) },
    encrypted: sealed(value.get('encrypted')),
  };
  if (value.has('prf')) {
    const prf = value.get('prf');
    check(isTextKeyed(prf) && exactKeys(prf, ['credentialId', 'prfInput', 'mkWrap']), 'prf');
    const credentialId = prf.get('credentialId');
    const prfInput = prf.get('prfInput');
    check(credentialId instanceof Uint8Array && credentialId.length >= 1, 'credentialId');
    check(isBytes(prfInput, 32), 'prfInput');
    out.prf = { credentialId, prfInput, mkWrap: sealed(prf.get('mkWrap'), WRAP_LENGTH) };
  }
  if (value.has('replacesVaultId')) {
    const replaces = value.get('replacesVaultId');
    check(isId(replaces), 'replacesVaultId');
    out.replacesVaultId = replaces;
  }
  return out;
}

function idList(value: CborValue | undefined, what: string): Uint8Array[] {
  check(Array.isArray(value) && value.every(isId), what);
  let previous: Uint8Array | undefined;
  for (const id of value) {
    if (previous !== undefined) check(compareBytes(previous, id) < 0, what);
    previous = id;
  }
  return value;
}

const STATE_KEYS = [
  'preferences',
  'hlc',
  'lastBackupAt',
  'lastPhraseId',
  'lastSyncByPeer',
  'seenDevices',
  'seenRetiredDevices',
  'rejectedPeers',
] as const;
const ENCRYPTED_KEYS = ['deviceIdentity', ...STATE_KEYS] as const;

/** Whether every preference is an integer within its range (D151). */
export function preferencesValid(p: Preferences): boolean {
  return (Object.keys(PREFERENCE_RANGES) as (keyof Preferences)[]).every((k) =>
    uintIn(p[k], PREFERENCE_RANGES[k][0], PREFERENCE_RANGES[k][1]),
  );
}

/** The encrypted part, read after it is opened at unlock. */
export function readLocalConfigEncrypted(value: CborValue): LocalConfigEncrypted {
  check(isTextKeyed(value) && onlyKeys(value, ENCRYPTED_KEYS), 'encrypted part');
  const identity = value.get('deviceIdentity');
  check(
    isTextKeyed(identity) && exactKeys(identity, ['publicKey', 'privateKey']),
    'deviceIdentity',
  );
  const publicKey = identity.get('publicKey');
  const privateKey = identity.get('privateKey');
  check(isBytes(publicKey, 32) && isBytes(privateKey, 32), 'deviceIdentity');
  const state = new Map(value);
  state.delete('deviceIdentity');
  return { deviceIdentity: { publicKey, privateKey }, ...readLocalConfigState(state) };
}

/** The encrypted part as `openLocalConfigPart` returns it: everything but the device identity. */
export function readLocalConfigState(value: CborValue): LocalConfigState {
  check(isTextKeyed(value) && onlyKeys(value, STATE_KEYS), 'encrypted part');
  const prefs = value.get('preferences');
  check(isTextKeyed(prefs) && exactKeys(prefs, Object.keys(PREFERENCE_RANGES)), 'preferences');
  const preferences = Object.fromEntries(prefs) as unknown as Preferences;
  check(preferencesValid(preferences), 'preferences');

  const raw = value.get('hlc');
  check(Array.isArray(raw) && raw.length === 3, 'hlc');
  const [physicalMs, counter, deviceId] = raw;
  check(typeof physicalMs === 'number' && typeof counter === 'number' && isId(deviceId), 'hlc');
  const hlc = { physicalMs, counter, deviceId };
  checkHlc(hlc);

  const out: { -readonly [K in keyof LocalConfigState]: LocalConfigState[K] } = {
    preferences,
    hlc,
  };
  if (value.has('lastBackupAt')) {
    const at = value.get('lastBackupAt');
    check(isUint(at), 'lastBackupAt');
    out.lastBackupAt = at;
  }
  if (value.has('lastPhraseId')) {
    const id = value.get('lastPhraseId');
    check(isId(id), 'lastPhraseId');
    out.lastPhraseId = id;
  }
  if (value.has('lastSyncByPeer')) {
    const peers = value.get('lastSyncByPeer');
    check(Array.isArray(peers), 'lastSyncByPeer');
    const pairs = peers.map((p) => {
      check(Array.isArray(p) && p.length === 2 && isId(p[0]) && isUint(p[1]), 'lastSyncByPeer');
      return [p[0], p[1]] as const;
    });
    idList(
      pairs.map(([id]) => id),
      'lastSyncByPeer',
    );
    out.lastSyncByPeer = pairs;
  }
  for (const key of ['seenDevices', 'seenRetiredDevices', 'rejectedPeers'] as const) {
    if (value.has(key)) out[key] = idList(value.get(key), key);
  }
  return out;
}

function sealedToCbor(sealed: Sealed): CborMap {
  return new Map<CborValue, CborValue>([
    ['n', sealed.n],
    ['c', sealed.c],
  ]);
}

/** The cleartext Local Config map, refused unless it reads back as valid. */
export function localConfigToCbor(config: LocalConfigCleartext): CborMap {
  const map: CborMap = new Map<CborValue, CborValue>([
    ['localConfigFormatVersion', LOCAL_CONFIG_FORMAT_VERSION],
    ['vaultId', config.vaultId],
    ['localConfigId', config.localConfigId],
    [
      'kek',
      new Map<CborValue, CborValue>([
        ['salt', config.kek.salt],
        ['opslimit', config.kek.opslimit],
        ['memlimit', config.kek.memlimit],
        ['mkWrap', sealedToCbor(config.kek.mkWrap)],
      ]),
    ],
    ['encrypted', sealedToCbor(config.encrypted)],
  ]);
  if (config.prf) {
    map.set(
      'prf',
      new Map<CborValue, CborValue>([
        ['credentialId', config.prf.credentialId],
        ['prfInput', config.prf.prfInput],
        ['mkWrap', sealedToCbor(config.prf.mkWrap)],
      ]),
    );
  }
  if (config.replacesVaultId) map.set('replacesVaultId', config.replacesVaultId);
  readLocalConfig(map);
  return map;
}

/** The encrypted part's map without the device identity, refused unless it reads back as valid. */
export function localConfigStateToCbor(state: LocalConfigState): CborMap {
  const map: CborMap = new Map<CborValue, CborValue>([
    [
      'preferences',
      new Map<CborValue, CborValue>([
        ['autoLockMinutes', state.preferences.autoLockMinutes],
        ['hiddenLockSeconds', state.preferences.hiddenLockSeconds],
        ['clipboardClearSeconds', state.preferences.clipboardClearSeconds],
      ]),
    ],
    ['hlc', [state.hlc.physicalMs, state.hlc.counter, state.hlc.deviceId]],
  ]);
  if (state.lastBackupAt !== undefined) map.set('lastBackupAt', state.lastBackupAt);
  if (state.lastPhraseId) map.set('lastPhraseId', state.lastPhraseId);
  if (state.lastSyncByPeer) {
    map.set(
      'lastSyncByPeer',
      state.lastSyncByPeer.map(([id, at]) => [id, at]),
    );
  }
  for (const key of ['seenDevices', 'seenRetiredDevices', 'rejectedPeers'] as const) {
    const ids = state[key];
    if (ids) map.set(key, [...ids]);
  }
  readLocalConfigState(map);
  return map;
}

/** Decodes and reads stored Local Config bytes; any failure is a corrupt Local Config. */
export function parseLocalConfig(bytes: Uint8Array): LocalConfigCleartext {
  let value: CborValue;
  try {
    value = decodeCbor(bytes);
  } catch {
    throw new ContentInvalidError('local config');
  }
  return readLocalConfig(value);
}
