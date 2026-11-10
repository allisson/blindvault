// Bitwarden's unencrypted JSON export (overview §15, D123). Copied from BlindPass's parser and
// adapted to `SourceItem` (architecture.md, BlindPass inventory). An encrypted export, protected by
// a password or by the account key, carries `"encrypted": true` and is refused (D146).

import { ImportRejectedError } from '../errors';
import {
  type Json,
  type SourceField,
  type SourceItem,
  type SourceParse,
  expiry,
  field,
  isObject,
  object,
  optional,
  readJson,
  rest,
  text,
} from './source';

const TEMPLATES = new Map([
  [1, 'login'],
  [2, 'secure-note'],
  [3, 'card'],
  [4, 'identity'],
  [5, 'developer-credential'],
]);

/** Text (0), hidden (1) and boolean (2) fields; a linked field (3) points at another, no value. */
function custom(list: unknown): SourceField[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((f: unknown) => {
    if (!isObject(f) || !text(f.name) || ![0, 1, 2].includes(f.type as number)) return [];
    return field(text(f.name), text(f.value), undefined, f.type === 1);
  });
}

function fields(o: Json): SourceField[] {
  switch (o.type) {
    case 1: {
      const login = object(o.login);
      const uris = Array.isArray(login.uris) ? login.uris : [];
      const [url, ...more] = uris.map((u: unknown) => text(object(u).uri)).filter(Boolean);
      return [
        ...field('Username', text(login.username), 'username'),
        ...field('Password', text(login.password), 'password'),
        ...field('URL', url, 'url'),
        ...more.flatMap((u) => field('URL', u)),
        ...field('TOTP', text(login.totp)),
      ];
    }
    case 3: {
      const card = object(o.card);
      return [
        ...field('Cardholder', text(card.cardholderName), 'cardholder'),
        ...field('Number', text(card.number), 'number'),
        ...expiry(text(card.expMonth), text(card.expYear)),
        ...field('CVV', text(card.code), 'cvv'),
        ...field('Brand', text(card.brand)),
      ];
    }
    case 4: {
      const id = object(o.identity);
      return [
        ...field('First name', text(id.firstName), 'firstName'),
        ...field('Last name', text(id.lastName), 'lastName'),
        ...field('Email', text(id.email), 'email'),
        ...field('Phone', text(id.phone), 'phone'),
        ...field('Address', text(id.address1), 'address'),
        ...rest(id, ['firstName', 'lastName', 'email', 'phone', 'address1']),
      ];
    }
    case 5: {
      const key = object(o.sshKey);
      return [
        ...field('Private key', text(key.privateKey), 'secret'),
        ...field('Public key', text(key.publicKey)),
        ...field('Fingerprint', text(key.keyFingerprint)),
      ];
    }
    default:
      return [];
  }
}

function item(o: Json, folders: Map<string, string[]>): SourceItem {
  const template = typeof o.type === 'number' ? TEMPLATES.get(o.type) : undefined;
  const category =
    typeof o.type === 'number' ? `Bitwarden type ${String(o.type)}` : 'Bitwarden item';
  return {
    title: text(o.name),
    ...(template ? { template } : { category }),
    fields: [...fields(o), ...custom(o.fields)],
    ...optional(text(o.notes), folders.get(text(o.folderId))),
  };
}

/** Parses a Bitwarden JSON export; an entry that is not an object is skipped and counted. */
export function parseBitwardenJson(json: string): SourceParse {
  const data = readJson(json);
  if (!isObject(data)) throw new ImportRejectedError('not-this-format');
  if (data.encrypted === true) throw new ImportRejectedError('encrypted-export');
  if (!Array.isArray(data.items)) throw new ImportRejectedError('not-this-format');
  // A folder named `a/b` is Bitwarden's nesting.
  const folders = new Map(
    (Array.isArray(data.folders) ? data.folders : [])
      .filter(isObject)
      .map((f) => [text(f.id), text(f.name).split('/').filter(Boolean)]),
  );
  const items = data.items.filter(isObject).map((o) => item(o, folders));
  return { items, skipped: data.items.length - items.length };
}
