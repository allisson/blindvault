// A BlindPass plaintext export (`docs/blindpass-format.md`, D123), or the plaintext a `.blindpass`
// export decrypts to. Copied from BlindPass's `importVaultPlaintext` and adapted: its Zod schema
// becomes the shape checks below, and each item becomes a `SourceItem`.

import { ImportRejectedError } from '../errors';
import { type SourceField, type SourceItem, type SourceParse, field, optional } from './source';

type Json = Record<string, unknown>;

class Invalid extends Error {}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A required string. */
function req(o: Json, key: string): string {
  const v = o[key];
  if (typeof v !== 'string') throw new Invalid();
  return v;
}

/** An optional string; absent or `null` reads as ''. */
function opt(o: Json, key: string): string {
  const v = o[key];
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new Invalid();
  return v;
}

/** An optional integer in [min, max]. */
function int(o: Json, key: string, min: number, max: number): number | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new Invalid();
  return v;
}

function custom(o: Json): SourceField[] {
  const list = o.customFields;
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Invalid();
  return list.flatMap((entry: unknown) => {
    if (!isObject(entry)) throw new Invalid();
    return field(req(entry, 'label'), req(entry, 'value'));
  });
}

/** `YYYY-MM` from BlindPass's month and year strings, when both are numbers. */
function expiry(month: string, year: string): string {
  if (!/^\d{1,2}$/.test(month) || !/^(\d{2}|\d{4})$/.test(year)) return '';
  return `${year.length === 2 ? `20${year}` : year}-${month.padStart(2, '0')}`;
}

/** An `otpauth://` URI carrying a BlindPass TOTP item's parameters, so D133 reads it as TOTP. */
function otpauth(o: Json): string {
  const algorithm = opt(o, 'algorithm') || 'SHA1';
  if (!['SHA1', 'SHA256', 'SHA512'].includes(algorithm)) throw new Invalid();
  const digits = int(o, 'digits', 6, 8) ?? 6;
  const period = int(o, 'period', 15, 300) ?? 30;
  const secret = req(o, 'secret');
  const issuer = opt(o, 'issuer');
  const account = opt(o, 'accountName');
  const label = [issuer, account].filter(Boolean).map(encodeURIComponent).join(':');
  const query = new URLSearchParams({
    secret,
    algorithm,
    digits: String(digits),
    period: String(period),
  });
  if (issuer) query.set('issuer', issuer);
  return `otpauth://totp/${label}?${query.toString()}`;
}

function developerCredential(o: Json): SourceField[] {
  const mode = o.credentialMode;
  if (mode === 'ssh_key') {
    return [
      ...field('Private key', req(o, 'privateKey'), 'secret'),
      ...field('Public key', req(o, 'publicKey')),
      ...field('Passphrase', opt(o, 'passphrase')),
      ...field('Username', req(o, 'username')),
      ...field('Host', req(o, 'host')),
      ...field('Algorithm', opt(o, 'algorithm')),
      ...field('Fingerprint', opt(o, 'fingerprint')),
    ];
  }
  const api = [
    ...field('Provider', req(o, 'provider'), 'provider'),
    ...field('Environment', opt(o, 'environment')),
    ...field('Base URL', opt(o, 'baseUrl'), 'baseUrl'),
  ];
  if (mode === 'token') {
    return [
      ...api,
      ...field('Key ID', opt(o, 'keyId'), 'keyId'),
      ...field('Secret', req(o, 'secret'), 'secret'),
    ];
  }
  if (mode === 'client_secret_pair') {
    return [
      ...api,
      ...field('Client ID', req(o, 'clientId')),
      ...field('Client secret', req(o, 'clientSecret'), 'secret'),
    ];
  }
  throw new Invalid();
}

function item(o: Json): SourceItem {
  const title = req(o, 'title');
  const extra = custom(o);
  const notes = opt(o, 'notes');
  const make = (
    kind: { template: string } | { category: string },
    fields: SourceField[],
    text = notes,
  ): SourceItem => ({ title, ...kind, fields: [...fields, ...extra], ...optional(text) });
  switch (o.type) {
    case 'login':
      return make({ template: 'login' }, [
        ...field('Username', req(o, 'username'), 'username'),
        ...field('Password', req(o, 'password'), 'password'),
        ...field('URL', opt(o, 'url'), 'url'),
      ]);
    case 'secure_note':
      return make({ template: 'secure-note' }, [], req(o, 'content'));
    case 'payment_card': {
      const [month, year] = [req(o, 'expMonth'), req(o, 'expYear')];
      const date = expiry(month, year);
      return make({ template: 'card' }, [
        ...field('Cardholder', req(o, 'cardholderName'), 'cardholder'),
        ...field('Number', req(o, 'number'), 'number'),
        ...(date
          ? field('Expiry', date, 'expiry')
          : [...field('Expiry month', month), ...field('Expiry year', year)]),
        ...field('CVV', opt(o, 'cvv'), 'cvv'),
      ]);
    }
    case 'identity':
      return make({ template: 'identity' }, [
        ...field('First name', req(o, 'firstName'), 'firstName'),
        ...field('Last name', req(o, 'lastName'), 'lastName'),
        ...field('Email', opt(o, 'email'), 'email'),
        ...field('Phone', opt(o, 'phone'), 'phone'),
        ...field('Address', opt(o, 'address'), 'address'),
        ...field('City', opt(o, 'city')),
        ...field('Country', opt(o, 'country')),
      ]);
    case 'totp':
      return make({ category: 'TOTP' }, field('TOTP', otpauth(o)));
    case 'developer_credential':
    case 'api_key':
      return make({ template: 'developer-credential' }, developerCredential(o));
    case 'crypto_wallet':
      if (o.walletMode !== 'bip39') throw new Invalid();
      return make({ template: 'crypto-wallet' }, [
        ...field('Wallet name', opt(o, 'walletName'), 'walletName'),
        ...field('Network', opt(o, 'network'), 'network'),
        ...field('Recovery phrase', req(o, 'mnemonic'), 'seedPhrase'),
        ...field('Passphrase', opt(o, 'passphrase'), 'passphrase'),
        ...field('Derivation path', opt(o, 'derivationPath'), 'derivationPath'),
        ...field('Address', opt(o, 'addressHint'), 'address'),
      ]);
    default:
      throw new Invalid();
  }
}

/** Parses a BlindPass plaintext export; refuses the whole file on any mismatch, as BlindPass does. */
export function parseBlindPassExport(json: string): SourceParse {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new ImportRejectedError('not-this-format');
  }
  if (!isObject(data) || data.type !== 'blindpass-export') {
    throw new ImportRejectedError('not-this-format');
  }
  if (data.version !== 1) throw new ImportRejectedError('unsupported-version');
  const items = data.items;
  if (!Array.isArray(items)) throw new ImportRejectedError('not-this-format');
  return {
    items: items.map((entry: unknown, i) => {
      try {
        if (!isObject(entry)) throw new Invalid();
        return item(entry);
      } catch {
        throw new ImportRejectedError('invalid-item', i);
      }
    }),
    skipped: 0,
  };
}
