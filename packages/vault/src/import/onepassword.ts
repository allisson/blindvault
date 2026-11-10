// 1Password's `.1pux` export (overview §15, D123): a zip whose `export.data` is JSON, accounts →
// vaults → items. Copied from BlindPass's parser and adapted to `SourceItem` (architecture.md,
// BlindPass inventory): each vault is a folder, a login field's value is read as the plain string
// the export writes, and every field is kept, its source id giving the template role.

import { ImportRejectedError } from '../errors';
import {
  type Json,
  type SourceField,
  type SourceItem,
  type SourceParse,
  field,
  humanize,
  isObject,
  object,
  optional,
  readJson,
  text,
} from './source';
import { readText, readZip } from './zip';

const TEMPLATES = new Map([
  ['001', 'login'],
  ['002', 'card'],
  ['003', 'secure-note'],
  ['004', 'identity'],
  ['005', 'login'],
  ['112', 'developer-credential'],
  ['114', 'developer-credential'],
]);

const CATEGORIES = new Map([
  ['100', 'Software License'],
  ['101', 'Bank Account'],
  ['102', 'Database'],
  ['103', "Driver's License"],
  ['104', 'Outdoor License'],
  ['105', 'Membership'],
  ['106', 'Passport'],
  ['107', 'Rewards Program'],
  ['108', 'Social Security Number'],
  ['109', 'Wireless Router'],
  ['110', 'Server'],
  ['111', 'Email Account'],
  ['113', 'Medical Record'],
  ['115', 'Document'],
]);

/** The template role each source field id fills. */
const ROLES = new Map([
  [
    'login',
    new Map([
      ['username', 'username'],
      ['password', 'password'],
    ]),
  ],
  [
    'card',
    new Map([
      ['cardholder', 'cardholder'],
      ['ccnum', 'number'],
      ['expiry', 'expiry'],
      ['cvv', 'cvv'],
      ['pin', 'pin'],
    ]),
  ],
  [
    'identity',
    new Map([
      ['firstname', 'firstName'],
      ['lastname', 'lastName'],
      ['birthdate', 'birthDate'],
      ['email', 'email'],
      ['defphone', 'phone'],
      ['address', 'address'],
    ]),
  ],
  [
    'developer-credential',
    new Map([
      ['private_key', 'secret'],
      ['credential', 'secret'],
    ]),
  ],
]);

/** A section field's value, whose one key names its kind: `string`, `concealed`, `monthYear`… */
function read(value: unknown): { kind: string; text: string } {
  const [kind, v] = Object.entries(object(value)).find(([, x]) => x !== null) ?? ['', ''];
  if (typeof v === 'string' || typeof v === 'number') {
    const s = String(v);
    if (kind === 'monthYear' && /^\d{6}$/.test(s))
      return { kind, text: `${s.slice(0, 4)}-${s.slice(4)}` };
    if (kind === 'date' && typeof v === 'number') {
      const date = new Date(v * 1000);
      return { kind, text: Number.isNaN(date.getTime()) ? s : date.toISOString().slice(0, 10) };
    }
    return { kind, text: s };
  }
  const o = object(v);
  if (kind === 'address') {
    const parts = [o.street, o.city, o.state, o.zip, o.country].map(text).filter(Boolean);
    return { kind, text: parts.join(', ') };
  }
  return { kind, text: text(o.email_address) || text(o.privateKey) };
}

function fields(details: Json, overview: Json, template: string | undefined): SourceField[] {
  const roles = ROLES.get(template ?? '');
  const login = (Array.isArray(details.loginFields) ? details.loginFields : []).filter(isObject);
  const sections = (Array.isArray(details.sections) ? details.sections : []).filter(isObject);
  const urls = Array.isArray(overview.urls) ? overview.urls : [];
  const [url, ...more] = [
    ...new Set([text(overview.url), ...urls.map((u: unknown) => text(object(u).url))]),
  ].filter(Boolean);
  return [
    ...login.flatMap((f) => {
      const key = text(f.designation) || text(f.name) || text(f.id);
      const value = typeof f.value === 'string' ? f.value : read(f.value).text;
      return key
        ? field(humanize(key), value, roles?.get(text(f.designation)), f.fieldType === 'P')
        : [];
    }),
    ...field('Password', text(details.password), 'password'),
    ...field('URL', url, template === 'login' ? 'url' : undefined),
    ...more.flatMap((u) => field('URL', u)),
    ...sections.flatMap((s) =>
      (Array.isArray(s.fields) ? s.fields : []).filter(isObject).flatMap((f) => {
        const key = text(f.id) || text(f.name);
        const label = text(f.title) || humanize(key);
        const { kind, text: value } = read(f.value);
        return label ? field(label, value, roles?.get(key), kind === 'concealed') : [];
      }),
    ),
  ];
}

function item(o: Json, folder: string[]): SourceItem {
  const uuid = text(o.categoryUuid);
  const template = TEMPLATES.get(uuid);
  const overview = object(o.overview);
  const details = object(o.details);
  const tags = (Array.isArray(overview.tags) ? overview.tags : []).map(text).filter(Boolean);
  const attachments = [
    ...(Array.isArray(o.files) ? o.files : []).map((f: unknown) => text(object(f).fileName)),
    text(object(details.documentAttributes).fileName),
  ].filter(Boolean);
  const category = CATEGORIES.get(uuid) ?? (uuid ? `1Password category ${uuid}` : '1Password item');
  return {
    title: text(overview.title),
    ...(template ? { template } : { category }),
    fields: fields(details, overview, template),
    ...optional(text(details.notesPlain), folder),
    ...(tags.length > 0 ? { tags } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

/** Parses a 1Password `.1pux` export; an item that is not an object is skipped and counted. */
export function parseOnePasswordExport(bytes: Uint8Array): SourceParse {
  const data = readZip(bytes).get('export.data');
  if (data === undefined) throw new ImportRejectedError('not-this-format');
  const json = readJson(readText(data));
  if (!isObject(json) || !Array.isArray(json.accounts)) {
    throw new ImportRejectedError('not-this-format');
  }
  const items: SourceItem[] = [];
  let entries = 0;
  for (const account of json.accounts.filter(isObject)) {
    for (const vault of (Array.isArray(account.vaults) ? account.vaults : []).filter(isObject)) {
      const folder = [text(object(vault.attrs).name)].filter(Boolean);
      for (const entry of Array.isArray(vault.items) ? vault.items : []) {
        entries++;
        if (isObject(entry)) items.push(item(entry, folder));
      }
    }
  }
  return { items, skipped: entries - items.length };
}
