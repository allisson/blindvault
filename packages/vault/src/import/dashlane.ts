// Dashlane's `.zip` export (overview §15, D123): one CSV per kind of item. Copied from BlindPass's
// parser and adapted to `SourceItem` (architecture.md, BlindPass inventory): every column no reader
// takes is kept as a field, a credential's `category` is its folder, and only a credential with no
// password is skipped and counted, as in the other CSV formats.

import { ImportRejectedError } from '../errors';
import { loginTitle } from './csv-formats';
import { parseCsvRows } from './csv';
import {
  type Json,
  type SourceItem,
  type SourceParse,
  expiry,
  field,
  optional,
  rest,
  text,
} from './source';
import { baseName, readText, readZip } from './zip';

/** Each data row by lowercased header name. */
function records(raw: string): Json[] {
  const [header = [], ...rows] = parseCsvRows(raw);
  const names = header.map((h) => h.trim().toLowerCase());
  return rows.map((cells) => Object.fromEntries(names.map((n, i) => [n, cells[i] ?? ''])));
}

function credential(r: Json): SourceItem | undefined {
  if (!text(r.password)) return undefined;
  return {
    title: loginTitle(text(r.title), text(r.url)),
    template: 'login',
    fields: [
      ...field('Username', text(r.username), 'username'),
      ...field('Password', text(r.password), 'password'),
      ...field('URL', text(r.url), 'url'),
      ...field('TOTP', text(r.otpurl) || text(r.otpsecret)),
      ...rest(r, [
        'title',
        'username',
        'password',
        'url',
        'otpurl',
        'otpsecret',
        'note',
        'category',
      ]),
    ],
    ...optional(text(r.note), [text(r.category)].filter(Boolean)),
  };
}

/** A card when it has a number; a bank account or any other kind keeps its type as category. */
function payment(r: Json): SourceItem {
  const taken = ['type', 'account_name', 'name', 'note'];
  const card = text(r.cc_number) !== '';
  return {
    title: text(r.account_name) || text(r.name),
    ...(card ? { template: 'card' } : { category: `Dashlane ${text(r.type) || 'payment'}` }),
    fields: card
      ? [
          ...field('Cardholder', text(r.account_holder), 'cardholder'),
          ...field('Number', text(r.cc_number), 'number'),
          ...expiry(text(r.expiration_month), text(r.expiration_year)),
          ...field('CVV', text(r.code), 'cvv'),
          ...rest(r, [
            ...taken,
            'account_holder',
            'cc_number',
            'expiration_month',
            'expiration_year',
            'code',
          ]),
        ]
      : rest(r, taken),
    ...optional(text(r.note)),
  };
}

function id(r: Json): SourceItem {
  return {
    title: text(r.name) || text(r.number),
    category: `Dashlane ${text(r.type) || 'ID'}`,
    fields: rest(r, ['type', 'name', 'note']),
    ...optional(text(r.note)),
  };
}

function personalInfo(r: Json): SourceItem {
  const name = [text(r.first_name), text(r.last_name)].filter(Boolean).join(' ');
  return {
    title: text(r.item_name) || name,
    template: 'identity',
    fields: [
      ...field('First name', text(r.first_name), 'firstName'),
      ...field('Last name', text(r.last_name), 'lastName'),
      ...field('Email', text(r.email), 'email'),
      ...field('Phone', text(r.phone_number), 'phone'),
      ...field('Address', text(r.address), 'address'),
      ...rest(r, [
        'item_name',
        'first_name',
        'last_name',
        'email',
        'phone_number',
        'address',
        'note',
      ]),
    ],
    ...optional(text(r.note)),
  };
}

function secureNote(r: Json): SourceItem {
  return {
    title: text(r.title),
    template: 'secure-note',
    fields: rest(r, ['title', 'note']),
    ...optional(text(r.note)),
  };
}

/** By a word of the CSV's name, `ids` last since other names could hold it. */
const KINDS: [string, (r: Json) => SourceItem | undefined][] = [
  ['credentials', credential],
  ['payments', payment],
  ['personalinfo', personalInfo],
  ['securenotes', secureNote],
  ['ids', id],
];

/** Parses a Dashlane `.zip` export; a zip with none of its CSVs is refused. */
export function parseDashlaneExport(bytes: Uint8Array): SourceParse {
  const items: SourceItem[] = [];
  let skipped = 0;
  let found = false;
  for (const [name, content] of readZip(bytes)) {
    const base = baseName(name).toLowerCase();
    const read = base.endsWith('.csv') ? KINDS.find(([k]) => base.includes(k))?.[1] : undefined;
    if (!read) continue;
    found = true;
    for (const r of records(readText(content))) {
      const item = read(r);
      if (item) items.push(item);
      else skipped++;
    }
  }
  if (!found) throw new ImportRejectedError('not-this-format');
  return { items, skipped };
}
