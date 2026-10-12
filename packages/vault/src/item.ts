// Item content (record-content.md §2–§5, D52, D165): read with the read-only rules, written only
// when valid.

import { type CborMap, type CborValue, type TotpValue, checkTotpValue } from '@blindvault/crypto';
import { wordlist } from '@scure/bip39/wordlists/english.js';

import { ContentInvalidError } from './errors';
import { FIELD_TYPES, type FieldType, type Template, roleOf, template } from './templates';
import {
  compareCodePoints,
  isBoundedLine,
  isId,
  isSingleLine,
  isText,
  isTextKeyed,
  isUint,
} from './text';

export interface Field {
  readonly type: FieldType;
  /** Text for every type but `totp`. */
  readonly value: string | TotpValue;
  readonly role?: string;
  readonly label?: string;
}

export interface Item {
  readonly templateId: string;
  readonly templateVersion: number;
  readonly title: string;
  readonly fields: readonly Field[];
  readonly tags: readonly string[];
  readonly notes?: string;
  readonly folderId?: Uint8Array;
  readonly trashOperationId?: Uint8Array;
}

/** The section 2 rule that makes an item read-only. */
export type ReadOnlyRule = 1 | 2 | 3 | 4 | 5 | 6;

export type ItemReading =
  | { readonly readOnly: false; readonly item: Item }
  | { readonly readOnly: true; readonly rule: ReadOnlyRule };

export const TITLE_MAX = 512;
export const LABEL_MAX = 128;
export const TAG_MAX = 64;
export const TAGS_MAX = 32;
const SEED_PHRASE_WORDS = new Set([12, 15, 18, 21, 24]);
const WORDS = new Set(wordlist);
const ITEM_KEYS = new Set([
  'templateId',
  'templateVersion',
  'title',
  'fields',
  'tags',
  'notes',
  'folderId',
  'trashOperationId',
]);
const FIELD_KEYS = new Set(['type', 'value', 'role', 'label']);
const TOTP_KEYS = new Set(['secret', 'algorithm', 'digits', 'period', 'issuer', 'accountName']);
const TYPES = new Set<string>(FIELD_TYPES);

class ReadOnly extends Error {
  constructor(readonly rule: ReadOnlyRule) {
    super(`read-only: rule ${String(rule)}`);
  }
}

function require(condition: boolean, rule: ReadOnlyRule = 6): asserts condition {
  if (!condition) throw new ReadOnly(rule);
}

function hasUnknownKey(map: CborMap, known: ReadonlySet<string>): boolean {
  return [...map.keys()].some((k) => typeof k === 'string' && !known.has(k));
}

const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** `YYYY-MM-DD` (proleptic Gregorian) or `YYYY-MM`, year 0001 to 9999 (D170). */
export function isValidDate(value: string, monthOnly: boolean): boolean {
  const match = /^([0-9]{4})-([0-9]{2})(?:-([0-9]{2}))?$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 1 || month < 1 || month > 12) return false;
  if (match[3] === undefined) return true;
  if (monthOnly) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = month === 2 && leap ? 29 : Number(DAYS[month - 1]);
  const day = Number(match[3]);
  return day >= 1 && day <= days;
}

/**
 * Words of the BIP39 English list, NFKD, one U+0020 between them, 12 to 24 words. The checksum is
 * not checked: a bad one is shown, not refused (§4).
 */
export function isValidSeedPhrase(value: string): boolean {
  const words = value.split(' ');
  return (
    SEED_PHRASE_WORDS.has(words.length) &&
    value.normalize('NFKD') === value &&
    words.every((w) => WORDS.has(w))
  );
}

function readTotp(value: CborValue | undefined): TotpValue {
  require(isTextKeyed(value));
  require(!hasUnknownKey(value, TOTP_KEYS), 3);
  const secret = value.get('secret');
  const algorithm = value.get('algorithm');
  const digits = value.get('digits');
  const period = value.get('period');
  const issuer = value.get('issuer');
  const accountName = value.get('accountName');
  require(typeof secret === 'string' && typeof algorithm === 'string');
  require(typeof digits === 'number' && typeof period === 'number');
  require(value.has('issuer') ? typeof issuer === 'string' : true);
  require(value.has('accountName') ? typeof accountName === 'string' : true);
  const totp = {
    secret,
    algorithm,
    digits,
    period,
    ...(typeof issuer === 'string' ? { issuer } : {}),
    ...(typeof accountName === 'string' ? { accountName } : {}),
  } as TotpValue;
  try {
    checkTotpValue(totp);
  } catch {
    throw new ReadOnly(6);
  }
  return totp;
}

function readValue(
  type: FieldType,
  value: CborValue | undefined,
  monthOnly: boolean,
): Field['value'] {
  if (type === 'totp') return readTotp(value);
  switch (type) {
    case 'long-text':
    case 'secret':
      require(isText(value));
      return value;
    case 'date':
      require(typeof value === 'string' && isValidDate(value, monthOnly));
      return value;
    case 'number':
      require(typeof value === 'string' && /^-?[0-9]+(\.[0-9]+)?$/.test(value));
      return value;
    case 'seed-phrase':
      require(typeof value === 'string' && isValidSeedPhrase(value));
      return value;
    default:
      require(isSingleLine(value));
      return value;
  }
}

function readFields(raw: CborValue | undefined, t: Template): Field[] {
  require(Array.isArray(raw));
  // Rules 2–4 first: an unknown part makes the item read-only even if another part is invalid.
  for (const f of raw) {
    require(isTextKeyed(f));
    require(!hasUnknownKey(f, FIELD_KEYS), 3);
    const type = f.get('type');
    require(typeof type === 'string');
    require(TYPES.has(type), 2);
    const r = f.get('role');
    if (typeof r === 'string') require(roleOf(t, r) !== undefined, 4);
  }
  const roles = new Set<string>();
  return raw.map((f) => {
    const map = f as CborMap;
    const type = map.get('type') as FieldType;
    const r = map.get('role');
    const label = map.get('label');
    let monthOnly = false;
    if (map.has('role')) {
      require(typeof r === 'string' && !roles.has(r));
      const def = roleOf(t, r);
      require(def?.type === type);
      monthOnly = def.monthPrecision === true;
      roles.add(r);
    }
    if (map.has('label')) require(isBoundedLine(label, LABEL_MAX));
    require(map.has('role') || map.has('label'));
    require(map.has('value'));
    const value = readValue(type, map.get('value'), monthOnly);
    return {
      type,
      value,
      ...(typeof r === 'string' ? { role: r } : {}),
      ...(typeof label === 'string' ? { label } : {}),
    };
  });
}

function readTags(raw: CborValue | undefined): string[] {
  require(Array.isArray(raw) && raw.length <= TAGS_MAX);
  const tags = raw.map((t) => {
    require(isBoundedLine(t, TAG_MAX) && t.normalize('NFC') === t);
    return t;
  });
  require(new Set(tags.map((t) => t.toLowerCase())).size === tags.length);
  let previous: string | undefined;
  for (const tag of tags) {
    if (previous !== undefined) require(compareCodePoints(previous, tag) < 0);
    previous = tag;
  }
  return tags;
}

function read(content: CborValue, deleted: boolean | null): Item {
  require(isTextKeyed(content));
  require(!hasUnknownKey(content, ITEM_KEYS), 1);
  const templateId = content.get('templateId');
  const templateVersion = content.get('templateVersion');
  require(isUint(templateVersion) && templateVersion >= 1);
  const t = typeof templateId === 'string' ? template(templateId) : undefined;
  require(t !== undefined && templateVersion <= t.version, 5);
  const title = content.get('title');
  require(isBoundedLine(title, TITLE_MAX));
  const fields = readFields(content.get('fields'), t);
  const tags = readTags(content.get('tags'));
  const notes = content.get('notes');
  const folderId = content.get('folderId');
  const trashOperationId = content.get('trashOperationId');
  if (content.has('notes')) require(isText(notes));
  if (content.has('folderId')) require(isId(folderId));
  if (content.has('trashOperationId')) require(isId(trashOperationId));
  if (deleted !== null) require(content.has('trashOperationId') === deleted);
  return {
    templateId: t.id,
    templateVersion: Number(templateVersion),
    title,
    fields,
    tags,
    ...(typeof notes === 'string' ? { notes } : {}),
    ...(folderId instanceof Uint8Array ? { folderId } : {}),
    ...(trashOperationId instanceof Uint8Array ? { trashOperationId } : {}),
  };
}

/**
 * Reads decrypted item content. `deleted` is the Item record's header flag, or `null` for the item
 * inside an Item Version. Content from a newer app version, or malformed, is read-only (§2).
 */
export function readItem(content: CborValue, deleted: boolean | null): ItemReading {
  try {
    return { readOnly: false, item: read(content, deleted) };
  } catch (error) {
    // `read` throws only ReadOnly: every other check is caught inside it.
    return { readOnly: true, rule: (error as ReadOnly).rule };
  }
}

function totpToCbor(v: TotpValue): CborMap {
  const map: CborMap = new Map<CborValue, CborValue>([
    ['secret', v.secret],
    ['algorithm', v.algorithm],
    ['digits', v.digits],
    ['period', v.period],
  ]);
  if (v.issuer !== undefined) map.set('issuer', v.issuer);
  if (v.accountName !== undefined) map.set('accountName', v.accountName);
  return map;
}

/**
 * The content map of `item`, refused with `ContentInvalidError` unless it reads back as valid with
 * the header flag `deleted`. The caller normalizes input first (`normalizeTags`).
 */
export function itemToCbor(item: Item, deleted: boolean): CborMap {
  const fields = item.fields.map((f) => {
    const map: CborMap = new Map<CborValue, CborValue>([
      ['type', f.type],
      ['value', typeof f.value === 'string' ? f.value : totpToCbor(f.value)],
    ]);
    if (f.role !== undefined) map.set('role', f.role);
    if (f.label !== undefined) map.set('label', f.label);
    return map;
  });
  const map: CborMap = new Map<CborValue, CborValue>([
    ['templateId', item.templateId],
    ['templateVersion', item.templateVersion],
    ['title', item.title],
    ['fields', fields],
    ['tags', [...item.tags]],
  ]);
  if (item.notes !== undefined) map.set('notes', item.notes);
  if (item.folderId !== undefined) map.set('folderId', item.folderId);
  if (item.trashOperationId !== undefined) map.set('trashOperationId', item.trashOperationId);
  if (readItem(map, deleted).readOnly) throw new ContentInvalidError('item');
  return map;
}

/** Input tags as stored: NFC, trimmed, empty ones and case-insensitive duplicates dropped, sorted. */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.normalize('NFC').replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
    const key = tag.toLowerCase();
    if (tag === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out.sort(compareCodePoints);
}
