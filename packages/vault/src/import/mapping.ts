// The import mapping of overview §15 (D124, D131, D133, D242): a parser's source items into items
// that always write, each under its source folder path, with the counts the preview shows (D125).

import {
  ITEM_CAP,
  ID_LENGTH,
  itemContentLength,
  parseOtpauthUri,
  parseTotpSecret,
} from '@blindvault/crypto';

import {
  type Field,
  type Item,
  LABEL_MAX,
  TAGS_MAX,
  TAG_MAX,
  TITLE_MAX,
  isValidDate,
  isValidSeedPhrase,
  itemToCbor,
  normalizeSeedPhrase,
  normalizeTags,
} from '../item';
import { FOLDER_NAME_MAX } from '../folder';
import { type FieldType, type RoleDefinition, type Template, roleOf, template } from '../templates';
import { codePointLength } from '../text';
import type { SourceField, SourceItem, SourceParse } from './source';

export interface MappedItem {
  /** With no `folderId`: the import places it under its landing folder (D125). */
  readonly item: Item;
  /** The source folder path, outermost first, blank names left out; empty for the landing folder. */
  readonly folder: readonly string[];
}

export interface MappedImport {
  readonly items: readonly MappedItem[];
  /** Source entries the parser left out, and items above the item cap (D129, D139). */
  readonly skipped: number;
  /** Source attachments dropped, each named in its item's notes. */
  readonly attachments: number;
  /** Items whose category matched no template, turned into Secure Notes. */
  readonly notes: number;
}

// Copied from BlindPass's `isSecretKey` (apps/web/src/lib/import/customFields.ts), run against the
// key lowercased with every other character run as `_`; short tokens need `_` boundaries.
const SECRET_SUBSTRINGS = /password|secret|mnemonic|recovery_?phrase|private_?key|^totp/;
const SECRET_TOKENS = /(^|_)(pin|cvv|cvc)(_|$)/;
const TOTP_TOKENS = /(^|_)(totp|otp|2fa|mfa|one_time_password)(_|$)|authenticator/;

const SECRET_TYPES = new Set<FieldType>(['secret', 'seed-phrase', 'totp']);
// The Secure Note template (templates.ts): no roles, so every field keeps its label.
const NOTE: Template = { id: 'secure-note', version: 1, roles: [] };

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function isSecretKey(key: string): boolean {
  const k = normalizedKey(key);
  return SECRET_SUBSTRINGS.test(k) || SECRET_TOKENS.test(k);
}

function isTotpKey(key: string): boolean {
  return TOTP_TOKENS.test(normalizedKey(key));
}

/** Single-line, trimmed, at most `max` code points; '' when nothing is left. */
function bounded(text: string, max: number): string {
  const line = text.replace(/[\r\n]+/g, ' ').trim();
  return Array.from(line).slice(0, max).join('').trim();
}

function totpOf(f: SourceField): Field['value'] | undefined {
  try {
    return parseOtpauthUri(f.value);
  } catch {
    // Not a URI: a bare base32 secret counts only under a TOTP-looking key (D133).
  }
  if (!isTotpKey(f.key)) return undefined;
  try {
    return parseTotpSecret(f.value);
  } catch {
    return undefined;
  }
}

/** The value as the role's type stores it, or nothing when it fails that type (D242). */
function roleValue(def: RoleDefinition, value: string): string | undefined {
  switch (def.type) {
    case 'long-text':
    case 'secret':
      return value;
    case 'date':
      return isValidDate(value, def.monthPrecision === true) ? value : undefined;
    case 'seed-phrase': {
      const phrase = normalizeSeedPhrase(value);
      return isValidSeedPhrase(phrase) ? phrase : undefined;
    }
    default:
      return /[\r\n]/.test(value) ? undefined : value;
  }
}

function mapField(f: SourceField, t: Template, taken: Set<string>): Field {
  const label = bounded(f.key, LABEL_MAX) || 'Field';
  const totp = totpOf(f);
  if (totp !== undefined) return { type: 'totp', value: totp, label };
  const def = f.role === undefined || taken.has(f.role) ? undefined : roleOf(t, f.role);
  // A hidden value fills only a masked role: the source hid it (D242).
  if (def && (f.hidden !== true || SECRET_TYPES.has(def.type))) {
    const value = roleValue(def, f.value);
    if (value !== undefined) {
      taken.add(def.role);
      return { type: def.type, value, role: def.role };
    }
  }
  // A TOTP-looking key is secret-looking too: a value that is no TOTP stays masked (D131).
  const secret =
    f.hidden === true ||
    isSecretKey(f.key) ||
    isTotpKey(f.key) ||
    (def !== undefined && SECRET_TYPES.has(def.type));
  if (secret) return { type: 'secret', value: f.value, label };
  return { type: /[\r\n]/.test(f.value) ? 'long-text' : 'text', value: f.value, label };
}

/** The item of a source item; `note` when its category matched no template. */
function mapItem(source: SourceItem): { item: Item; note: boolean } {
  const known = source.template === undefined ? undefined : template(source.template);
  const t = known ?? NOTE;
  const note = known === undefined;
  const title = bounded(source.title, TITLE_MAX) || 'Untitled';
  const category = note ? bounded(source.category ?? '', TITLE_MAX) : '';
  const taken = new Set<string>();
  const fields = source.fields.filter((f) => f.value !== '').map((f) => mapField(f, t, taken));

  const valid = (tag: string) => !/[\r\n]/.test(tag) && codePointLength(tag.trim()) <= TAG_MAX;
  const tags = normalizeTags((source.tags ?? []).filter(valid));
  const extraTags = [...(source.tags ?? []).filter((tag) => !valid(tag)), ...tags.slice(TAGS_MAX)];
  const lost = source.attachments ?? [];
  const notes = [
    source.notes ?? '',
    lost.length > 0 ? `[Lost attachments: ${lost.join(', ')}]` : '',
    extraTags.length > 0 ? `[More tags: ${extraTags.join(', ')}]` : '',
  ]
    .filter((part) => part !== '')
    .join('\n\n');

  return {
    item: {
      templateId: t.id,
      templateVersion: t.version,
      title: category ? bounded(`[${category}] ${title}`, TITLE_MAX) : title,
      fields,
      tags: tags.slice(0, TAGS_MAX),
      ...(notes ? { notes } : {}),
    },
    note,
  };
}

/** Maps every source item; one above the item cap, with its landing folder ID, is skipped. */
export function mapImport(parse: SourceParse): MappedImport {
  const items: MappedItem[] = [];
  let skipped = parse.skipped;
  let attachments = 0;
  let notes = 0;
  for (const source of parse.items) {
    const { item, note } = mapItem(source);
    const placed = itemToCbor({ ...item, folderId: new Uint8Array(ID_LENGTH) }, false);
    if (itemContentLength(placed) > ITEM_CAP) {
      skipped++;
      continue;
    }
    const folder = (source.folder ?? []).map((name) => bounded(name, FOLDER_NAME_MAX));
    items.push({ item, folder: folder.filter((name) => name !== '') });
    attachments += source.attachments?.length ?? 0;
    if (note) notes++;
  }
  return { items, skipped, attachments, notes };
}
