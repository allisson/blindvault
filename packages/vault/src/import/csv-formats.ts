// The CSV exports (overview §15, D123): Chrome (and Firefox, same columns), LastPass, Apple Passwords
// and KeePassXC. Copied from BlindPass's parsers and adapted to `SourceItem` (architecture.md,
// BlindPass inventory). A login with no password is skipped and counted; a header without the
// columns a format needs refuses the file.

import { ImportRejectedError } from '../errors';
import { parseCsvRows } from './csv';
import { type SourceField, type SourceItem, type SourceParse, field, optional } from './source';

type Row = (column: string) => string;

/** One reader per data row, by lowercased header name; '' for a missing column or cell. */
function table(raw: string, required: readonly string[]): Row[] {
  const [header, ...rows] = parseCsvRows(raw);
  const names = (header ?? []).map((h) => h.trim().toLowerCase());
  if (header === undefined || required.some((r) => !names.includes(r))) {
    throw new ImportRejectedError('missing-columns');
  }
  return rows.map((cells) => (column) => cells[names.indexOf(column)] ?? '');
}

/** The source title, else the URL's host, else the URL. */
function title(name: string, url: string): string {
  if (name || !url) return name;
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

/** A login row, or nothing when it has no password. */
function login(
  row: Row,
  name: string,
  notes: string,
  extra: readonly SourceField[] = [],
  folder?: readonly string[],
): SourceItem | undefined {
  if (!row('password')) return undefined;
  const url = row('url');
  return {
    title: title(name, url),
    template: 'login',
    fields: [
      ...field('Username', row('username'), 'username'),
      ...field('Password', row('password'), 'password'),
      ...field('URL', url, 'url'),
      ...extra,
    ],
    ...optional(notes, folder),
  };
}

function collect(rows: Row[], read: (row: Row) => SourceItem | undefined): SourceParse {
  const items: SourceItem[] = [];
  for (const row of rows) {
    const item = read(row);
    if (item) items.push(item);
  }
  return { items, skipped: rows.length - items.length };
}

/** Chrome: `name,url,username,password,note`; Firefox: `url,username,password,…`. */
export function parseChromeCsv(raw: string): SourceParse {
  return collect(table(raw, ['username', 'password']), (row) =>
    login(row, row('name'), row('note')),
  );
}

/**
 * LastPass: `url,username,password,totp,extra,name,grouping,fav`. A secure note (`url` is
 * `http://sn`) keeps its text as a note, where BlindPass skipped it; `grouping` is the folder path,
 * `\`-separated.
 */
export function parseLastPassCsv(raw: string): SourceParse {
  return collect(table(raw, ['password']), (row) => {
    const folder = row('grouping').split('\\').filter(Boolean);
    if (row('url') === 'http://sn') {
      return {
        title: row('name'),
        template: 'secure-note',
        fields: [],
        ...optional(row('extra'), folder),
      };
    }
    return login(row, row('name'), row('extra'), field('TOTP', row('totp')), folder);
  });
}

/** Apple Passwords: `Title,URL,Username,Password,Notes,OTPAuth`. */
export function parseApplePasswordsCsv(raw: string): SourceParse {
  return collect(table(raw, ['username', 'password']), (row) =>
    login(row, row('title'), row('notes'), field('OTPAuth', row('otpauth'))),
  );
}

/**
 * KeePassXC: `Group,Title,Username,Password,URL,Notes,TOTP,…`. `Group` is the folder path,
 * `/`-separated, where BlindPass dropped it.
 */
export function parseKeePassXcCsv(raw: string): SourceParse {
  return collect(table(raw, ['password']), (row) =>
    login(
      row,
      row('title'),
      row('notes'),
      field('TOTP', row('totp')),
      row('group').split('/').filter(Boolean),
    ),
  );
}
