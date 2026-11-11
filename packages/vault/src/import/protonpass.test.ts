import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { ImportRejectedError } from '../errors';
import { MAX_ZIP_ENTRIES } from './zip';
import { parseProtonPassJson, parseProtonPassZip } from './protonpass';

// Adapted from BlindPass (`apps/web/src/lib/import/__tests__/protonpass.test.ts`).

const file = (items: unknown[], name = 'Personal') =>
  JSON.stringify({
    version: '1.21.2',
    userId: 'u',
    encrypted: false,
    vaults: { v1: { name, items } },
  });

const one = (data: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
  const [parsed] = parseProtonPassJson(file([{ itemId: 'i', data, ...extra }], '')).items;
  return parsed;
};

function refused(json: string, reason: string) {
  expect(() => parseProtonPassJson(json)).toThrow(ImportRejectedError);
  try {
    parseProtonPassJson(json);
  } catch (e) {
    expect((e as ImportRejectedError).reason).toBe(reason);
  }
}

describe('Proton Pass JSON export', () => {
  it('reads a login with its URLs, TOTP, extra fields, notes and vault as folder', () => {
    const json = file([
      {
        itemId: 'i1',
        aliasEmail: null,
        data: {
          type: 'login',
          metadata: { name: 'GitHub', note: 'work account', itemUuid: 'x' },
          content: {
            itemUsername: 'alice',
            itemEmail: 'alice@example.com',
            password: 'secret',
            urls: ['https://github.com', '', 'https://gist.github.com'],
            totpUri: 'otpauth://totp/GitHub:alice?secret=JBSW&issuer=GitHub',
            passkeys: [{ keyId: 'k', content: 'c' }],
          },
          extraFields: [
            { fieldName: 'Security answer', type: 'hidden', data: { content: 'maiden name' } },
            {
              fieldName: 'Backup 2FA',
              type: 'totp',
              data: { totpUri: 'otpauth://totp/B?secret=AB' },
            },
            { fieldName: 'Note', type: 'text', data: { content: 'plain' } },
            { fieldName: '', type: 'text', data: { content: 'nameless' } },
            { fieldName: 'No data', type: 'text' },
            'not a field',
          ],
        },
      },
    ]);
    expect(parseProtonPassJson(json)).toEqual({
      items: [
        {
          title: 'GitHub',
          template: 'login',
          fields: [
            { key: 'Username', value: 'alice', role: 'username' },
            { key: 'Email', value: 'alice@example.com' },
            { key: 'Password', value: 'secret', role: 'password' },
            { key: 'URL', value: 'https://github.com', role: 'url' },
            { key: 'URL', value: 'https://gist.github.com' },
            { key: 'TOTP', value: 'otpauth://totp/GitHub:alice?secret=JBSW&issuer=GitHub' },
            { key: 'Security answer', value: 'maiden name', hidden: true },
            { key: 'Backup 2FA', value: 'otpauth://totp/B?secret=AB' },
            { key: 'Note', value: 'plain' },
          ],
          notes: 'work account',
          folder: ['Personal'],
        },
      ],
      skipped: 0,
    });
  });

  it('takes the email as username when there is no username, and reads a login with no content', () => {
    expect(
      one({ type: 'login', metadata: { name: 'X' }, content: { itemEmail: 'a@b.com', urls: 'x' } })
        ?.fields,
    ).toEqual([{ key: 'Username', value: 'a@b.com', role: 'username' }]);
    expect(one({ type: 'login' })).toEqual({ title: '', template: 'login', fields: [] });
  });

  it('reads a note, its text as notes', () => {
    expect(one({ type: 'note', metadata: { name: 'My Note', note: 'body' }, content: {} })).toEqual(
      {
        title: 'My Note',
        template: 'secure-note',
        fields: [],
        notes: 'body',
      },
    );
  });

  it('reads a card, its expiry as YYYY-MM from either form', () => {
    expect(
      one({
        type: 'creditCard',
        metadata: { name: 'Visa' },
        content: {
          cardholderName: 'A. Person',
          cardType: 0,
          number: '4111111111111111',
          verificationNumber: '123',
          expirationDate: '2027-3',
          pin: '9999',
        },
      })?.fields,
    ).toEqual([
      { key: 'Cardholder', value: 'A. Person', role: 'cardholder' },
      { key: 'Number', value: '4111111111111111', role: 'number' },
      { key: 'Expiry', value: '2027-03', role: 'expiry' },
      { key: 'CVV', value: '123', role: 'cvv' },
      { key: 'PIN', value: '9999', role: 'pin' },
    ]);
    const expiry = (expirationDate: string) =>
      one({ type: 'creditCard', content: { expirationDate } })?.fields;
    expect(expiry('03/2030')).toEqual([{ key: 'Expiry', value: '2030-03', role: 'expiry' }]);
    expect(expiry('3 / 30')).toEqual([{ key: 'Expiry', value: '2030-03', role: 'expiry' }]);
    expect(expiry('NEVER')).toEqual([{ key: 'Expiry', value: 'NEVER' }]);
    expect(expiry('')).toEqual([]);
  });

  it('reads an identity, keeping every other key and the section fields', () => {
    expect(
      one({
        type: 'identity',
        metadata: { name: 'Me' },
        content: {
          fullName: 'Alice Smith',
          firstName: 'Alice',
          lastName: 'Smith',
          email: 'a@b.com',
          phoneNumber: '+1 555',
          streetAddress: '1 Main St',
          city: 'NYC',
          socialSecurityNumber: '123',
          extraPersonalDetails: [{ fieldName: 'Pet', type: 'text', data: { content: 'Rex' } }],
          extraSections: [
            {
              sectionName: 'Work',
              sectionFields: [{ fieldName: 'Badge', type: 'hidden', data: { content: 'B-1' } }],
            },
          ],
        },
      })?.fields,
    ).toEqual([
      { key: 'First name', value: 'Alice', role: 'firstName' },
      { key: 'Last name', value: 'Smith', role: 'lastName' },
      { key: 'Email', value: 'a@b.com', role: 'email' },
      { key: 'Phone', value: '+1 555', role: 'phone' },
      { key: 'Address', value: '1 Main St', role: 'address' },
      { key: 'Full Name', value: 'Alice Smith' },
      { key: 'City', value: 'NYC' },
      { key: 'Social Security Number', value: '123' },
      { key: 'Pet', value: 'Rex' },
      { key: 'Badge', value: 'B-1', hidden: true },
    ]);
  });

  it('reads an SSH key as a developer credential', () => {
    expect(
      one({
        type: 'sshKey',
        metadata: { name: 'Key' },
        content: { privateKey: 'PRIV', publicKey: 'ssh-ed25519 AAAA', comment: 'laptop' },
      })?.fields,
    ).toEqual([
      { key: 'Private key', value: 'PRIV', role: 'secret' },
      { key: 'Public key', value: 'ssh-ed25519 AAAA' },
      { key: 'Comment', value: 'laptop' },
    ]);
  });

  it('keeps an alias, with its address, and any other type, under its category name', () => {
    expect(
      one(
        { type: 'alias', metadata: { name: 'a@proton.me' }, content: {} },
        { aliasEmail: 'a@proton.me' },
      ),
    ).toEqual({
      title: 'a@proton.me',
      category: 'Proton alias',
      fields: [{ key: 'Alias', value: 'a@proton.me' }],
    });
    expect(
      one({
        type: 'wifi',
        metadata: { name: 'Home' },
        content: { ssid: 'net', password: 'pw', security: 1 },
      }),
    ).toEqual({
      title: 'Home',
      category: 'Proton wifi',
      fields: [
        { key: 'Ssid', value: 'net' },
        { key: 'Password', value: 'pw' },
      ],
    });
    expect(one({ metadata: { name: 'Typeless' } })).toEqual({
      title: 'Typeless',
      category: 'Proton item',
      fields: [],
    });
  });

  it('reads every vault, and skips and counts an entry with no data object', () => {
    const json = JSON.stringify({
      vaults: {
        v1: {
          name: 'A',
          items: [{ data: { type: 'note', metadata: { name: 'a' } } }, { itemId: 'x' }],
        },
        v2: { name: 'B', items: [null, { data: { type: 'note', metadata: { name: 'b' } } }] },
        v3: { name: 'C', items: 'x' },
        v4: null,
      },
    });
    expect(parseProtonPassJson(json)).toEqual({
      items: [
        { title: 'a', template: 'secure-note', fields: [], folder: ['A'] },
        { title: 'b', template: 'secure-note', fields: [], folder: ['B'] },
      ],
      skipped: 2,
    });
  });

  it('refuses a PGP-encrypted export (D146)', () => {
    refused(
      '\n-----BEGIN PGP MESSAGE-----\n\nwcBMA...\n-----END PGP MESSAGE-----\n',
      'encrypted-export',
    );
    refused(JSON.stringify({ encrypted: true, vaults: {} }), 'encrypted-export');
  });

  it('refuses a file that is not a Proton Pass JSON export', () => {
    refused('not json', 'not-this-format');
    refused('null', 'not-this-format');
    refused('{}', 'not-this-format');
    refused('{"vaults":[]}', 'not-this-format');
  });
});

describe('Proton Pass zip export', () => {
  const zipRefused = (bytes: Uint8Array, reason: string) => {
    expect(() => parseProtonPassZip(bytes)).toThrow(ImportRejectedError);
    try {
      parseProtonPassZip(bytes);
    } catch (e) {
      expect((e as ImportRejectedError).reason).toBe(reason);
    }
  };

  it('reads its data.json', () => {
    const bytes = zipSync({
      'Proton Pass/data.json': strToU8(file([{ data: { type: 'note', metadata: { name: 'n' } } }])),
    });
    expect(parseProtonPassZip(bytes)).toEqual({
      items: [{ title: 'n', template: 'secure-note', fields: [], folder: ['Personal'] }],
      skipped: 0,
    });
  });

  it('refuses the encrypted export, its data.pgp (D146)', () => {
    zipRefused(
      zipSync({ 'Proton Pass/data.pgp': strToU8('-----BEGIN PGP MESSAGE-----') }),
      'encrypted-export',
    );
  });

  it('refuses an archive beyond the entry cap (D130)', () => {
    const files = Object.fromEntries(
      Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, i) => [`f${String(i)}`, new Uint8Array()]),
    );
    zipRefused(zipSync(files), 'too-large');
  });

  it('refuses a zip with no data.json, and a file that is not a zip', () => {
    zipRefused(zipSync({ 'Proton Pass/other.json': strToU8('{}') }), 'not-this-format');
    zipRefused(strToU8(file([])), 'not-this-format');
  });
});
