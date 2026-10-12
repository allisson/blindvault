// Folder and Device content (record-content.md §6, §7, D59): unknown keys are kept unchanged on
// every write; a known key with an invalid value is a verification failure.

import { type CborMap, type CborValue, PUBLIC_KEY_LENGTH } from '@blindvault/crypto';

import { ContentInvalidError } from './errors';
import { isBoundedLine, isBytes, isId, isTextKeyed, isUint, unknownKeys } from './text';

export const FOLDER_NAME_MAX = 256;
export const DISPLAY_NAME_MAX = 64;

export interface Folder {
  readonly name: string;
  readonly parentId?: Uint8Array;
  readonly trashOperationId?: Uint8Array;
}

export interface Device {
  readonly publicKey: Uint8Array;
  readonly displayName: string;
  readonly retired: boolean;
  readonly registeredAt: number | bigint;
}

/** A decoded Folder or Device with the content map it came from, so unknown keys survive writes. */
export interface Kept<T> {
  readonly value: T;
  readonly unknownKeys: readonly string[];
  readonly content: CborMap;
}

function check(condition: boolean, what: string): asserts condition {
  if (!condition) throw new ContentInvalidError(what);
}

const FOLDER_KEYS = new Set(['name', 'parentId', 'trashOperationId']);
const DEVICE_KEYS = new Set(['publicKey', 'displayName', 'retired', 'registeredAt']);

/** Reads a Folder; `deleted` is its header flag, which `trashOperationId` must match. */
export function readFolder(content: CborValue, deleted: boolean): Kept<Folder> {
  check(isTextKeyed(content), 'folder');
  const name = content.get('name');
  const parentId = content.get('parentId');
  const trashOperationId = content.get('trashOperationId');
  check(isBoundedLine(name, FOLDER_NAME_MAX), 'name');
  if (content.has('parentId')) check(isId(parentId), 'parentId');
  if (content.has('trashOperationId')) check(isId(trashOperationId), 'trashOperationId');
  check(content.has('trashOperationId') === deleted, 'trashOperationId');
  return {
    value: {
      name,
      ...(parentId instanceof Uint8Array ? { parentId } : {}),
      ...(trashOperationId instanceof Uint8Array ? { trashOperationId } : {}),
    },
    unknownKeys: unknownKeys(content, FOLDER_KEYS),
    content,
  };
}

/**
 * The content map of `folder`: the known keys from `folder`, every unknown key of `previous`
 * unchanged (D59). Refused unless it reads back as valid with `deleted`.
 */
export function folderToCbor(folder: Folder, deleted: boolean, previous?: CborMap): CborMap {
  const map: CborMap = new Map<CborValue, CborValue>();
  if (previous) {
    for (const key of unknownKeys(previous, FOLDER_KEYS))
      map.set(key, previous.get(key) as CborValue);
  }
  map.set('name', folder.name);
  if (folder.parentId !== undefined) map.set('parentId', folder.parentId);
  if (folder.trashOperationId !== undefined) map.set('trashOperationId', folder.trashOperationId);
  readFolder(map, deleted);
  return map;
}

export function readDevice(content: CborValue): Kept<Device> {
  check(isTextKeyed(content), 'device');
  const publicKey = content.get('publicKey');
  const displayName = content.get('displayName');
  const retired = content.get('retired');
  const registeredAt = content.get('registeredAt');
  check(isBytes(publicKey, PUBLIC_KEY_LENGTH), 'publicKey');
  check(isBoundedLine(displayName, DISPLAY_NAME_MAX), 'displayName');
  check(typeof retired === 'boolean', 'retired');
  check(isUint(registeredAt), 'registeredAt');
  return {
    value: { publicKey, displayName, retired, registeredAt },
    unknownKeys: unknownKeys(content, DEVICE_KEYS),
    content,
  };
}

/** The content map of `device`, keeping every unknown key of `previous` (D59). */
export function deviceToCbor(device: Device, previous?: CborMap): CborMap {
  const map: CborMap = new Map<CborValue, CborValue>();
  if (previous) {
    for (const key of unknownKeys(previous, DEVICE_KEYS))
      map.set(key, previous.get(key) as CborValue);
  }
  map.set('publicKey', device.publicKey);
  map.set('displayName', device.displayName);
  map.set('retired', device.retired);
  map.set('registeredAt', device.registeredAt);
  readDevice(map);
  return map;
}
