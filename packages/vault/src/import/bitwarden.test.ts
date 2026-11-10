import { describe, expect, it } from 'vitest';

import { ImportRejectedError } from '../errors';
import { parseBitwardenJson } from './bitwarden';

// Adapted from BlindPass (`apps/web/src/lib/import/__tests__/bitwarden.test.ts`).

const file = (items: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ encrypted: false, folders: [], items, ...extra });

const one = (item: Record<string, unknown>) => {
  const [parsed] = parseBitwardenJson(file([item])).items;
  return parsed;
};

function refused(json: string, reason: string) {
  expect(() => parseBitwardenJson(json)).toThrow(ImportRejectedError);
  try {
    parseBitwardenJson(json);
  } catch (e) {
    expect((e as ImportRejectedError).reason).toBe(reason);
  }
}

describe('Bitwarden JSON export', () => {
  it('reads a login with its URIs, TOTP, custom fields, notes and folder', () => {
    const json = file(
      [
        {
          id: '1',
          folderId: 'f1',
          type: 1,
          name: 'Google',
          notes: 'n',
          login: {
            username: 'user@gmail.com',
            password: 'pass123',
            uris: [
              { uri: 'https://google.com', match: null },
              { uri: '' },
              { uri: 'https://g.co' },
            ],
            totp: 'otpauth://totp/Google:user?secret=JBSWY3DPEHPK3PXP',
          },
          fields: [
            { name: 'API Key', value: 'abc123', type: 0 },
            { name: 'Token', value: 'secret', type: 1 },
            { name: 'Active', value: 'true', type: 2 },
            { name: 'Linked', value: 'something', type: 3, linkedId: 100 },
            { name: null, value: 'nameless', type: 0 },
            { name: 'Empty', value: null, type: 0 },
            'not a field',
          ],
        },
      ],
      { folders: [{ id: 'f1', name: 'Work/Accounts' }, { id: 'f2', name: '' }, null] },
    );
    expect(parseBitwardenJson(json)).toEqual({
      items: [
        {
          title: 'Google',
          template: 'login',
          fields: [
            { key: 'Username', value: 'user@gmail.com', role: 'username' },
            { key: 'Password', value: 'pass123', role: 'password' },
            { key: 'URL', value: 'https://google.com', role: 'url' },
            { key: 'URL', value: 'https://g.co' },
            { key: 'TOTP', value: 'otpauth://totp/Google:user?secret=JBSWY3DPEHPK3PXP' },
            { key: 'API Key', value: 'abc123' },
            { key: 'Token', value: 'secret', hidden: true },
            { key: 'Active', value: 'true' },
          ],
          notes: 'n',
          folder: ['Work', 'Accounts'],
        },
      ],
      skipped: 0,
    });
  });

  it('reads a login with no login object, no folder and custom fields not in a list', () => {
    expect(one({ type: 1, name: 'Bare', folderId: 'gone', fields: 'x', login: null })).toEqual({
      title: 'Bare',
      template: 'login',
      fields: [],
    });
    expect(one({ type: 1, name: 'No URIs', login: { password: 'p', uris: 'x' } })?.fields).toEqual([
      { key: 'Password', value: 'p', role: 'password' },
    ]);
  });

  it('reads a secure note, its text as notes', () => {
    expect(
      one({ type: 2, name: 'My Note', notes: 'secret content', secureNote: { type: 0 } }),
    ).toEqual({
      title: 'My Note',
      template: 'secure-note',
      fields: [],
      notes: 'secret content',
    });
  });

  it('reads a card, its expiry as YYYY-MM', () => {
    expect(
      one({
        type: 3,
        name: 'Visa',
        card: {
          cardholderName: 'John Doe',
          brand: 'Visa',
          number: '4111111111111111',
          expMonth: '3',
          expYear: '2028',
          code: '123',
        },
      }),
    ).toEqual({
      title: 'Visa',
      template: 'card',
      fields: [
        { key: 'Cardholder', value: 'John Doe', role: 'cardholder' },
        { key: 'Number', value: '4111111111111111', role: 'number' },
        { key: 'Expiry', value: '2028-03', role: 'expiry' },
        { key: 'CVV', value: '123', role: 'cvv' },
        { key: 'Brand', value: 'Visa' },
      ],
    });
  });

  it('keeps a card expiry that is not a number apart, and reads a card with no card object', () => {
    expect(one({ type: 3, name: 'C', card: { expMonth: 'March', expYear: '28' } })?.fields).toEqual(
      [
        { key: 'Expiry month', value: 'March' },
        { key: 'Expiry year', value: '28' },
      ],
    );
    expect(one({ type: 3, name: 'C', card: { expMonth: '12', expYear: '28' } })?.fields).toEqual([
      { key: 'Expiry', value: '2028-12', role: 'expiry' },
    ]);
    expect(one({ type: 3, name: 'C' })?.fields).toEqual([]);
  });

  it('reads an identity, keeping every other key as a field', () => {
    expect(
      one({
        type: 4,
        name: 'Me',
        identity: {
          title: 'Mr',
          firstName: 'John',
          middleName: null,
          lastName: 'Doe',
          address1: '123 Main St',
          address2: 'Apt 4',
          city: 'Springfield',
          postalCode: '12345',
          email: 'john@example.com',
          phone: null,
          ssn: '123-45-6789',
          passportNumber: 'X1',
        },
      })?.fields,
    ).toEqual([
      { key: 'First name', value: 'John', role: 'firstName' },
      { key: 'Last name', value: 'Doe', role: 'lastName' },
      { key: 'Email', value: 'john@example.com', role: 'email' },
      { key: 'Address', value: '123 Main St', role: 'address' },
      { key: 'Title', value: 'Mr' },
      { key: 'Address2', value: 'Apt 4' },
      { key: 'City', value: 'Springfield' },
      { key: 'Postal Code', value: '12345' },
      { key: 'Ssn', value: '123-45-6789' },
      { key: 'Passport Number', value: 'X1' },
    ]);
  });

  it('reads an SSH key as a developer credential', () => {
    expect(
      one({
        type: 5,
        name: 'Prod Key',
        sshKey: {
          privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----',
          publicKey: 'ssh-ed25519 AAAA',
          keyFingerprint: 'SHA256:abc',
        },
      }),
    ).toEqual({
      title: 'Prod Key',
      template: 'developer-credential',
      fields: [
        { key: 'Private key', value: '-----BEGIN OPENSSH PRIVATE KEY-----', role: 'secret' },
        { key: 'Public key', value: 'ssh-ed25519 AAAA' },
        { key: 'Fingerprint', value: 'SHA256:abc' },
      ],
    });
  });

  it('gives an unknown type its category name, and an item with no type a generic one', () => {
    expect(
      one({ type: 99, name: 'Unknown', fields: [{ name: 'k', value: 'v', type: 0 }] }),
    ).toEqual({
      title: 'Unknown',
      category: 'Bitwarden type 99',
      fields: [{ key: 'k', value: 'v' }],
    });
    expect(one({ name: 'Orphan' })).toEqual({
      title: 'Orphan',
      category: 'Bitwarden item',
      fields: [],
    });
    expect(one({ type: 'login' })).toEqual({ title: '', category: 'Bitwarden item', fields: [] });
  });

  it('skips and counts an entry that is not an object', () => {
    expect(parseBitwardenJson('{"items":[]}')).toEqual({ items: [], skipped: 0 });
    expect(parseBitwardenJson(file([null, 'x', [], { type: 2, name: 'N' }]))).toEqual({
      items: [{ title: 'N', template: 'secure-note', fields: [] }],
      skipped: 3,
    });
  });

  it('refuses an encrypted export, password-protected or tied to the account (D146)', () => {
    refused(
      JSON.stringify({
        encrypted: true,
        passwordProtected: true,
        salt: 'c2FsdA==',
        kdfType: 0,
        kdfIterations: 600000,
        encKeyValidation_DO_NOT_EDIT: '2.aaa|bbb|ccc',
        data: '2.ddd|eee|fff',
      }),
      'encrypted-export',
    );
    refused(
      JSON.stringify({
        encrypted: true,
        encKeyValidation_DO_NOT_EDIT: '2.aaa|bbb|ccc',
        folders: [],
        items: [{ type: 1, name: '2.ggg|hhh|iii' }],
      }),
      'encrypted-export',
    );
  });

  it('refuses a file that is not a Bitwarden JSON export', () => {
    refused('not json', 'not-this-format');
    refused('[]', 'not-this-format');
    refused('{}', 'not-this-format');
    refused('{"items":"x"}', 'not-this-format');
  });
});
