import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { ImportRejectedError } from '../errors';
import { parseOnePasswordExport } from './onepassword';

// Adapted from BlindPass (`apps/web/src/lib/import/__tests__/1password.test.ts`), with the login
// fields as the export writes them: a plain string value and a `designation`.

const pux = (data: unknown) =>
  zipSync({ 'export.attributes': strToU8('{}'), 'export.data': strToU8(JSON.stringify(data)) });

const file = (items: unknown[], vault = '') =>
  pux({ accounts: [{ attrs: { name: 'Me' }, vaults: [{ attrs: { name: vault }, items }] }] });

const one = (item: Record<string, unknown>) => parseOnePasswordExport(file([item])).items[0];

const section = (...fields: unknown[]) => ({ sections: [{ title: 'S', fields }] });

function refused(bytes: Uint8Array, reason: string) {
  expect(() => parseOnePasswordExport(bytes)).toThrow(ImportRejectedError);
  try {
    parseOnePasswordExport(bytes);
  } catch (e) {
    expect((e as ImportRejectedError).reason).toBe(reason);
  }
}

describe('1Password .1pux export', () => {
  it('reads a login with its URLs, TOTP, fields, notes, tags, attachments and vault', () => {
    const bytes = file(
      [
        {
          uuid: 'u1',
          categoryUuid: '001',
          overview: {
            title: 'GitHub',
            url: 'https://github.com',
            urls: [
              { label: '', url: 'https://github.com' },
              { url: 'https://gist.github.com' },
              'x',
            ],
            tags: ['work', 7],
          },
          details: {
            loginFields: [
              { value: 'alice', name: 'login', fieldType: 'T', designation: 'username' },
              { value: 'secret', name: 'pass', fieldType: 'P', designation: 'password' },
              { value: 'blue', name: 'color', fieldType: 'T' },
              { value: 'pw2', id: 'other', fieldType: 'P' },
              { value: 'nameless', fieldType: 'T' },
              'not a field',
            ],
            sections: [
              {
                title: 'Security',
                fields: [
                  {
                    title: 'one-time password',
                    id: 'TOTP_1',
                    value: { totp: 'otpauth://totp/GitHub:alice?secret=JBSW' },
                  },
                  { title: 'Answer', id: 'q1', value: { concealed: 'maiden name' } },
                  { id: 'recovery_code', value: { string: 'R-1' } },
                  { title: 'Empty', id: 'e', value: { string: '' } },
                  { value: { string: 'no key' } },
                  null,
                ],
              },
              { title: 'No fields' },
              'not a section',
            ],
            notesPlain: 'work account',
            passwordHistory: [{ value: 'old', time: 1 }],
          },
          files: [{ fileName: 'recovery.pdf' }, { fileName: '' }, null],
        },
      ],
      'Private',
    );
    expect(parseOnePasswordExport(bytes)).toEqual({
      items: [
        {
          title: 'GitHub',
          template: 'login',
          fields: [
            { key: 'Username', value: 'alice', role: 'username' },
            { key: 'Password', value: 'secret', role: 'password', hidden: true },
            { key: 'Color', value: 'blue' },
            { key: 'Other', value: 'pw2', hidden: true },
            { key: 'URL', value: 'https://github.com', role: 'url' },
            { key: 'URL', value: 'https://gist.github.com' },
            { key: 'one-time password', value: 'otpauth://totp/GitHub:alice?secret=JBSW' },
            { key: 'Answer', value: 'maiden name', hidden: true },
            { key: 'Recovery code', value: 'R-1' },
          ],
          notes: 'work account',
          folder: ['Private'],
          tags: ['work'],
          attachments: ['recovery.pdf'],
        },
      ],
      skipped: 0,
    });
  });

  it('reads a login field still written as a value object, and an item with nothing', () => {
    expect(
      one({
        categoryUuid: '001',
        details: { loginFields: [{ designation: 'username', value: { string: 'bob' } }] },
      })?.fields,
    ).toEqual([{ key: 'Username', value: 'bob', role: 'username' }]);
    expect(one({ categoryUuid: '001' })).toEqual({ title: '', template: 'login', fields: [] });
  });

  it('reads a password item as a login with no username', () => {
    expect(
      one({ categoryUuid: '005', overview: { title: 'PIN' }, details: { password: 'hunter2' } }),
    ).toEqual({
      title: 'PIN',
      template: 'login',
      fields: [{ key: 'Password', value: 'hunter2', role: 'password' }],
    });
  });

  it('reads a card, its month-year expiry as YYYY-MM', () => {
    expect(
      one({
        categoryUuid: '002',
        overview: { title: 'Visa', url: 'https://bank.example' },
        details: section(
          { title: 'cardholder name', id: 'cardholder', value: { string: 'A. Person' } },
          { title: 'type', id: 'type', value: { creditCardType: 'visa' } },
          { title: 'number', id: 'ccnum', value: { creditCardNumber: '4111111111111111' } },
          { title: 'verification number', id: 'cvv', value: { concealed: '123' } },
          { title: 'expiry date', id: 'expiry', value: { monthYear: 202712 } },
          { title: 'valid from', id: 'validFrom', value: { monthYear: 2001 } },
          { title: 'PIN', id: 'pin', value: { concealed: '9999' } },
        ),
      })?.fields,
    ).toEqual([
      { key: 'URL', value: 'https://bank.example' },
      { key: 'cardholder name', value: 'A. Person', role: 'cardholder' },
      { key: 'type', value: 'visa' },
      { key: 'number', value: '4111111111111111', role: 'number' },
      { key: 'verification number', value: '123', role: 'cvv', hidden: true },
      { key: 'expiry date', value: '2027-12', role: 'expiry' },
      { key: 'valid from', value: '2001' },
      { key: 'PIN', value: '9999', role: 'pin', hidden: true },
    ]);
  });

  it('reads a secure note, its text as notes', () => {
    expect(
      one({ categoryUuid: '003', overview: { title: 'Note' }, details: { notesPlain: 'body' } }),
    ).toEqual({ title: 'Note', template: 'secure-note', fields: [], notes: 'body' });
  });

  it('reads an identity: its address on one line, dates as YYYY-MM-DD, emails by address', () => {
    expect(
      one({
        categoryUuid: '004',
        overview: { title: 'Me' },
        details: section(
          { title: 'first name', id: 'firstname', value: { string: 'Alice' } },
          { title: 'last name', id: 'lastname', value: { string: 'Smith' } },
          { title: 'birth date', id: 'birthdate', value: { date: 631152000 } },
          { title: 'odd date', id: 'odd', value: { date: 1e20 } },
          {
            title: 'email',
            id: 'email',
            value: { email: { email_address: 'a@b.com', provider: null } },
          },
          { title: 'default phone', id: 'defphone', value: { phone: '+1 555' } },
          { title: 'cell', id: 'cellphone', value: { phone: '+1 666' } },
          {
            title: 'address',
            id: 'address',
            value: {
              address: { street: '1 Main', city: 'NYC', state: '', zip: '1', country: 'us' },
            },
          },
          { title: 'gender', id: 'sex', value: { gender: null, menu: 'female' } },
          { title: 'unknown', id: 'u', value: { other: { x: 1 } } },
          { title: 'blank', id: 'b', value: {} },
        ),
      })?.fields,
    ).toEqual([
      { key: 'first name', value: 'Alice', role: 'firstName' },
      { key: 'last name', value: 'Smith', role: 'lastName' },
      { key: 'birth date', value: '1990-01-01', role: 'birthDate' },
      { key: 'odd date', value: '100000000000000000000' },
      { key: 'email', value: 'a@b.com', role: 'email' },
      { key: 'default phone', value: '+1 555', role: 'phone' },
      { key: 'cell', value: '+1 666' },
      { key: 'address', value: '1 Main, NYC, 1, us', role: 'address' },
      { key: 'gender', value: 'female' },
    ]);
  });

  it('reads an SSH key and an API credential as developer credentials', () => {
    expect(
      one({
        categoryUuid: '114',
        overview: { title: 'Key' },
        details: section(
          {
            title: 'private key',
            id: 'private_key',
            value: { sshKey: { privateKey: 'PRIV', metadata: { publicKey: 'ssh-ed25519 A' } } },
          },
          { title: 'key type', id: 'key_type', value: { string: 'ed25519' } },
        ),
      }),
    ).toEqual({
      title: 'Key',
      template: 'developer-credential',
      fields: [
        { key: 'private key', value: 'PRIV', role: 'secret' },
        { key: 'key type', value: 'ed25519' },
      ],
    });
    expect(
      one({
        categoryUuid: '112',
        details: section(
          { title: 'credential', id: 'credential', value: { concealed: 'ghp_x' } },
          { title: 'hostname', id: 'hostname', value: { string: 'api.github.com' } },
        ),
      })?.fields,
    ).toEqual([
      { key: 'credential', value: 'ghp_x', role: 'secret', hidden: true },
      { key: 'hostname', value: 'api.github.com' },
    ]);
  });

  it('keeps any other category under its name, a document with its file as attachment', () => {
    expect(
      one({
        categoryUuid: '101',
        overview: { title: 'Chase' },
        details: section({ title: 'account number', id: 'accountNo', value: { string: '12' } }),
      }),
    ).toEqual({
      title: 'Chase',
      category: 'Bank Account',
      fields: [{ key: 'account number', value: '12' }],
    });
    expect(
      one({
        categoryUuid: '115',
        overview: { title: 'Scan' },
        details: { documentAttributes: { fileName: 'scan.pdf', documentId: 'd' } },
      }),
    ).toEqual({ title: 'Scan', category: 'Document', fields: [], attachments: ['scan.pdf'] });
    expect(one({ categoryUuid: '999' })).toEqual({
      title: '',
      category: '1Password category 999',
      fields: [],
    });
    expect(one({})).toEqual({ title: '', category: '1Password item', fields: [] });
  });

  it('reads every account and vault, and skips and counts an item that is not an object', () => {
    const bytes = pux({
      accounts: [
        { vaults: [{ attrs: { name: 'A' }, items: [{ categoryUuid: '003' }, null] }] },
        { vaults: [{ items: ['x', { categoryUuid: '003' }] }, { items: 'x' }, null] },
        { vaults: 'x' },
        null,
      ],
    });
    expect(parseOnePasswordExport(bytes)).toEqual({
      items: [
        { title: '', template: 'secure-note', fields: [], folder: ['A'] },
        { title: '', template: 'secure-note', fields: [] },
      ],
      skipped: 2,
    });
  });

  it('refuses a file that is not a 1Password export', () => {
    refused(zipSync({ 'export.attributes': strToU8('{}') }), 'not-this-format');
    refused(zipSync({ 'export.data': strToU8('not json') }), 'not-this-format');
    refused(pux({ accounts: 'x' }), 'not-this-format');
    refused(pux(null), 'not-this-format');
    refused(strToU8('{"accounts":[]}'), 'not-this-format');
  });
});
