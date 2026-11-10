// What an import parser reads from a source file, before the mapping of overview §15 (D124) turns
// it into items: the source's own keys and values, with no BlindVault rule applied yet.

import { ImportRejectedError } from '../errors';

export interface SourceField {
  /** The source's name for the value, kept as the field's label when no role takes it. */
  readonly key: string;
  readonly value: string;
  /** A role of the item's template the parser knows the value fills (`username`, `password`…). */
  readonly role?: string;
  /** The source marks the value hidden (a Bitwarden or Proton Pass hidden field). */
  readonly hidden?: true;
}

export interface SourceItem {
  readonly title: string;
  /** The factory template the source category matches; absent, the item has none (D124). */
  readonly template?: string;
  /** The source's category name, for an item with no matching template (D124). */
  readonly category?: string;
  /** Values with empty strings left out. */
  readonly fields: readonly SourceField[];
  readonly notes?: string;
  /** The source folder or group path, outermost first (D125). */
  readonly folder?: readonly string[];
  readonly tags?: readonly string[];
  /** Names of the source attachments, which the import drops (D124). */
  readonly attachments?: readonly string[];
}

export interface SourceParse {
  readonly items: readonly SourceItem[];
  /** Source entries left out, each counted once (overview §15, the preview). */
  readonly skipped: number;
}

/** The field, or nothing for an empty value. */
export function field(
  key: string,
  value: string | undefined,
  role?: string,
  hidden = false,
): SourceField[] {
  if (value === undefined || value === '') return [];
  return [{ key, value, ...(role === undefined ? {} : { role }), ...(hidden ? { hidden } : {}) }];
}

/** The optional keys of a source item, left out when empty. */
export function optional(
  notes: string | undefined,
  folder?: readonly string[],
): Pick<SourceItem, 'notes' | 'folder'> {
  return {
    ...(notes ? { notes } : {}),
    ...(folder && folder.length > 0 ? { folder } : {}),
  };
}

export type Json = Record<string, unknown>;

export function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value when it is a string, else ''. */
export function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A JSON export, or a refusal when the file is not JSON. */
export function readJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    throw new ImportRejectedError('not-this-format');
  }
}

/** A card's expiry as `YYYY-MM`, or the month and year apart when either is not a number. */
export function expiry(month: string, year: string): SourceField[] {
  if (!/^\d{1,2}$/.test(month) || !/^(\d{2}|\d{4})$/.test(year)) {
    return [...field('Expiry month', month), ...field('Expiry year', year)];
  }
  const full = year.length === 2 ? `20${year}` : year;
  return field('Expiry', `${full}-${month.padStart(2, '0')}`, 'expiry');
}

/** A source key as a label: `phoneNumber` and `phone_number` read `Phone Number`. */
export function humanize(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase());
}

/** Each non-empty string of `o` but the `taken` keys, labelled from its key. */
export function rest(o: Json, taken: readonly string[]): SourceField[] {
  return Object.entries(o).flatMap(([key, value]) =>
    taken.includes(key) ? [] : field(humanize(key), text(value)),
  );
}
