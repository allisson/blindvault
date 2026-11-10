// Proton Pass's unencrypted JSON export, the `Proton Pass/data.json` of its zip (overview §15,
// D123). Copied from BlindPass's parser and adapted to `SourceItem` (architecture.md, BlindPass
// inventory): each vault is a folder, and content keys no reader takes are kept as fields. A
// PGP-encrypted export is refused (D146): here as an armored message, and as the zip's `data.pgp`
// by the zip reader.

import { ImportRejectedError } from '../errors';
import {
  type Json,
  type SourceField,
  type SourceItem,
  type SourceParse,
  field,
  isObject,
  optional,
  readJson,
  rest,
  text,
  expiry,
} from './source';

const TEMPLATES = new Map([
  ['login', 'login'],
  ['note', 'secure-note'],
  ['creditCard', 'card'],
  ['identity', 'identity'],
  ['sshKey', 'developer-credential'],
]);

function object(value: unknown): Json {
  return isObject(value) ? value : {};
}

/** Extra fields, and the fields of the sections that hold them. */
function extras(list: unknown[]): SourceField[] {
  return list.flatMap((f: unknown) => {
    if (!isObject(f)) return [];
    if (Array.isArray(f.sectionFields)) return extras(f.sectionFields);
    const data = object(f.data);
    const value = text(data.content) || text(data.totpUri);
    return text(f.fieldName) ? field(text(f.fieldName), value, undefined, f.type === 'hidden') : [];
  });
}

/** `YYYY-MM` or `MM/YY(YY)`; any other text is kept as it is. */
function cardExpiry(date: string): SourceField[] {
  const iso = /^(\d{4})-(\d{1,2})$/.exec(date);
  if (iso) return expiry(iso[2] ?? '', iso[1] ?? '');
  const slash = /^(\d{1,2})\s*\/\s*(\d{2,4})$/.exec(date);
  if (slash) return expiry(slash[1] ?? '', slash[2] ?? '');
  return field('Expiry', date);
}

function content(type: string, c: Json): SourceField[] {
  switch (type) {
    case 'login': {
      const urls = Array.isArray(c.urls) ? c.urls : [];
      const [url, ...more] = urls.map(text).filter(Boolean);
      const username = text(c.itemUsername);
      return [
        ...field('Username', username || text(c.itemEmail), 'username'),
        ...(username ? field('Email', text(c.itemEmail)) : []),
        ...field('Password', text(c.password), 'password'),
        ...field('URL', url, 'url'),
        ...more.flatMap((u) => field('URL', u)),
        ...field('TOTP', text(c.totpUri)),
        ...rest(c, ['itemUsername', 'itemEmail', 'password', 'urls', 'totpUri']),
      ];
    }
    case 'creditCard':
      return [
        ...field('Cardholder', text(c.cardholderName), 'cardholder'),
        ...field('Number', text(c.number), 'number'),
        ...cardExpiry(text(c.expirationDate)),
        ...field('CVV', text(c.verificationNumber), 'cvv'),
        ...field('PIN', text(c.pin), 'pin'),
        ...rest(c, ['cardholderName', 'number', 'expirationDate', 'verificationNumber', 'pin']),
      ];
    case 'identity':
      return [
        ...field('First name', text(c.firstName), 'firstName'),
        ...field('Last name', text(c.lastName), 'lastName'),
        ...field('Email', text(c.email), 'email'),
        ...field('Phone', text(c.phoneNumber), 'phone'),
        ...field('Address', text(c.streetAddress), 'address'),
        ...rest(c, ['firstName', 'lastName', 'email', 'phoneNumber', 'streetAddress']),
      ];
    case 'sshKey':
      return [
        ...field('Private key', text(c.privateKey), 'secret'),
        ...field('Public key', text(c.publicKey)),
        ...rest(c, ['privateKey', 'publicKey']),
      ];
    default:
      return rest(c, []);
  }
}

function item(entry: Json, data: Json, folder: string[]): SourceItem {
  const type = text(data.type);
  const template = TEMPLATES.get(type);
  const meta = object(data.metadata);
  const c = object(data.content);
  return {
    title: text(meta.name),
    ...(template ? { template } : { category: `Proton ${type || 'item'}` }),
    fields: [
      ...content(type, c),
      ...Object.values(c).flatMap((v) => (Array.isArray(v) ? extras(v) : [])),
      ...field('Alias', text(entry.aliasEmail)),
      ...extras(Array.isArray(data.extraFields) ? data.extraFields : []),
    ],
    ...optional(text(meta.note), folder),
  };
}

/** Parses a Proton Pass JSON export; an entry with no `data` object is skipped and counted. */
export function parseProtonPassJson(json: string): SourceParse {
  if (json.trimStart().startsWith('-----BEGIN PGP MESSAGE-----')) {
    throw new ImportRejectedError('encrypted-export');
  }
  const data = readJson(json);
  if (!isObject(data)) throw new ImportRejectedError('not-this-format');
  if (data.encrypted === true) throw new ImportRejectedError('encrypted-export');
  if (!isObject(data.vaults)) throw new ImportRejectedError('not-this-format');
  const items: SourceItem[] = [];
  let entries = 0;
  for (const vault of Object.values(data.vaults)) {
    if (!isObject(vault) || !Array.isArray(vault.items)) continue;
    const folder = [text(vault.name)].filter(Boolean);
    for (const entry of vault.items) {
      entries++;
      if (isObject(entry) && isObject(entry.data)) items.push(item(entry, entry.data, folder));
    }
  }
  return { items, skipped: entries - items.length };
}
