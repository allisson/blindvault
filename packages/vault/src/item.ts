// Item content (record-content.md §2–§5, D52, D165): read with the read-only rules, written only
// when valid.

import {
  BLOB_ID_LENGTH,
  BLOB_KEY_LENGTH,
  type CborMap,
  type CborValue,
  MAX_ATTACHMENT_SIZE,
  type TotpValue,
  checkTotpValue,
} from '@blindvault/crypto';
import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

import { ContentInvalidError } from './errors';
import { FIELD_TYPES, type FieldType, type Template, roleOf, template } from './templates';
import {
  codePointLength,
  compareCodePoints,
  isBoundedLine,
  isBytes,
  isId,
  isSingleLine,
  isText,
  isTextKeyed,
  isUint,
  uintIn,
} from './text';

/** An `attachment` field's value (record-content.md §4, D278): the file's metadata and its blob. */
export interface AttachmentValue {
  /** The file's own name: single-line, 1 to 255 code points, not trimmed. */
  readonly name: string;
  /** The file's length in bytes, 1 to `MAX_ATTACHMENT_SIZE`. */
  readonly size: number;
  /** Shown as text only, never used to open the file (attachments.md §7). */
  readonly mediaType: string;
  /** BLAKE2b-256 of the blob as stored. */
  readonly blobId: Uint8Array;
  /** The blob's `secretstream` key. */
  readonly key: Uint8Array;
}

export interface Field {
  readonly type: FieldType;
  /** Text for every type but `totp` and `attachment`. */
  readonly value: string | TotpValue | AttachmentValue;
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
const ATTACHMENT_KEYS = new Set(['name', 'size', 'mediaType', 'blobId', 'key']);
export const ATTACHMENT_NAME_MAX = 255;
const EXTENSION_MAX = 16;
const MEDIA_TYPE = /^[\x21-\x7e]{1,255}$/;
const OCTET_STREAM = 'application/octet-stream';
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

/**
 * Seed-phrase input as stored: NFKD, lowercase, words separated by one U+0020. It never repairs a
 * word: `isValidSeedPhrase` still refuses one outside the list (§4).
 */
export function normalizeSeedPhrase(input: string): string {
  return input
    .normalize('NFKD')
    .toLowerCase()
    .split(/\p{White_Space}+/u)
    .filter((w) => w !== '')
    .join(' ');
}

/** Whether a valid seed phrase also has a valid BIP39 checksum; a bad one is shown, not refused. */
export function seedPhraseChecksumValid(value: string): boolean {
  return isValidSeedPhrase(value) && validateMnemonic(value, wordlist);
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

function readAttachment(value: CborValue | undefined): AttachmentValue {
  require(isTextKeyed(value));
  require(!hasUnknownKey(value, ATTACHMENT_KEYS), 3);
  const name = value.get('name');
  const size = value.get('size');
  const mediaType = value.get('mediaType');
  const blobId = value.get('blobId');
  const key = value.get('key');
  require(isSingleLine(name) && codePointLength(name) <= ATTACHMENT_NAME_MAX);
  require(uintIn(size, 1, MAX_ATTACHMENT_SIZE));
  require(typeof mediaType === 'string' && MEDIA_TYPE.test(mediaType));
  require(isBytes(blobId, BLOB_ID_LENGTH) && isBytes(key, BLOB_KEY_LENGTH));
  return { name, size, mediaType, blobId, key };
}

/**
 * The `blobId`s an item's content cites (attachments.md §5): from every field of type `attachment`
 * whose value is a map with a 32-byte `blobId`, whether or not the rest of the item validates, so
 * an item read-only for newer content keeps its blobs.
 */
export function citedBlobIds(item: CborValue | null | undefined): Uint8Array[] {
  if (!(item instanceof Map)) return [];
  const fields = item.get('fields');
  if (!Array.isArray(fields)) return [];
  const cited: Uint8Array[] = [];
  for (const field of fields) {
    if (!(field instanceof Map) || field.get('type') !== 'attachment') continue;
    const value = field.get('value');
    const blobId = value instanceof Map ? value.get('blobId') : undefined;
    if (isBytes(blobId, BLOB_ID_LENGTH)) cited.push(blobId);
  }
  return cited;
}

/**
 * A picked file's name as stored (attachments.md §3): line breaks as spaces, cut to 255 code points
 * keeping an extension of 1 to 16 after the last `.`, `attachment` when empty.
 */
export function attachmentName(fileName: string): string {
  const points = Array.from(fileName.replace(/[\n\r]/g, ' '));
  if (points.length === 0) return 'attachment';
  if (points.length <= ATTACHMENT_NAME_MAX) return points.join('');
  const dot = points.lastIndexOf('.');
  const extension = points.length - dot - 1;
  if (dot < 0 || extension < 1 || extension > EXTENSION_MAX) {
    return points.slice(0, ATTACHMENT_NAME_MAX).join('');
  }
  const stem = points.slice(0, ATTACHMENT_NAME_MAX - extension - 1);
  return [...stem, ...points.slice(dot)].join('');
}

/** A picked file's media type as stored (attachments.md §3): `application/octet-stream` unless valid. */
export function attachmentMediaType(type: string): string {
  return MEDIA_TYPE.test(type) ? type : OCTET_STREAM;
}

function readValue(
  type: FieldType,
  value: CborValue | undefined,
  monthOnly: boolean,
): Field['value'] {
  if (type === 'totp') return readTotp(value);
  if (type === 'attachment') return readAttachment(value);
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
    // An attachment is shown by its name when it has no label (D278).
    require(map.has('role') || map.has('label') || type === 'attachment');
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

function valueToCbor(v: Field['value']): CborValue {
  if (typeof v === 'string') return v;
  if ('blobId' in v) {
    return new Map<CborValue, CborValue>([
      ['name', v.name],
      ['size', v.size],
      ['mediaType', v.mediaType],
      // Copies: the caller wipes the key of a new attachment once its item is written.
      ['blobId', v.blobId.slice()],
      ['key', v.key.slice()],
    ]);
  }
  return totpToCbor(v);
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
      ['value', valueToCbor(f.value)],
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
