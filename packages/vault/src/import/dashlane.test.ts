import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { ImportRejectedError } from '../errors';
import { MAX_ZIP_ENTRIES } from './zip';
import { parseDashlaneExport } from './dashlane';

// Adapted from BlindPass (`apps/web/src/lib/import/__tests__/dashlane.test.ts`).

const zip = (files: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([n, c]) => [n, strToU8(c)])));

const parse = (name: string, ...lines: string[]) =>
  parseDashlaneExport(zip({ [name]: lines.join('\n') }));

function refused(bytes: Uint8Array, reason: string) {
  expect(() => parseDashlaneExport(bytes)).toThrow(ImportRejectedError);
  try {
    parseDashlaneExport(bytes);
  } catch (e) {
    expect((e as ImportRejectedError).reason).toBe(reason);
  }
}

describe('Dashlane .zip export', () => {
  it('reads credentials, their TOTP, category as folder, and skips one with no password', () => {
    expect(
      parse(
        'credentials.csv',
        'username,username2,username3,title,password,note,url,category,otpSecret,otpUrl',
        'alice,alt,,GitHub,secret,my work,https://github.com,Work,JBSW,otpauth://totp/G?secret=JBSW',
        'bob,,,,pw,,https://www.example.com/login,,JBSW,',
        'carol,,,No password,,,https://x.example,,,',
      ),
    ).toEqual({
      items: [
        {
          title: 'GitHub',
          template: 'login',
          fields: [
            { key: 'Username', value: 'alice', role: 'username' },
            { key: 'Password', value: 'secret', role: 'password' },
            { key: 'URL', value: 'https://github.com', role: 'url' },
            { key: 'TOTP', value: 'otpauth://totp/G?secret=JBSW' },
            { key: 'Username2', value: 'alt' },
          ],
          notes: 'my work',
          folder: ['Work'],
        },
        {
          title: 'www.example.com',
          template: 'login',
          fields: [
            { key: 'Username', value: 'bob', role: 'username' },
            { key: 'Password', value: 'pw', role: 'password' },
            { key: 'URL', value: 'https://www.example.com/login', role: 'url' },
            { key: 'TOTP', value: 'JBSW' },
          ],
        },
      ],
      skipped: 1,
    });
  });

  it('reads a payment card with its expiry, and keeps a bank account under its type', () => {
    expect(
      parse(
        'payments.csv',
        'type,account_name,account_holder,cc_number,code,expiration_month,expiration_year,note,issuer,bank_code',
        'payment_card,Visa,A. Person,4111111111111111,123,3,2030,trip card,Chase,',
        'bank,Checking,A. Person,,,,,,,BIC1',
        ',,,,,,,,,',
      ).items,
    ).toEqual([
      {
        title: 'Visa',
        template: 'card',
        fields: [
          { key: 'Cardholder', value: 'A. Person', role: 'cardholder' },
          { key: 'Number', value: '4111111111111111', role: 'number' },
          { key: 'Expiry', value: '2030-03', role: 'expiry' },
          { key: 'CVV', value: '123', role: 'cvv' },
          { key: 'Issuer', value: 'Chase' },
        ],
        notes: 'trip card',
      },
      {
        title: 'Checking',
        category: 'Dashlane bank',
        fields: [
          { key: 'Account holder', value: 'A. Person' },
          { key: 'Bank code', value: 'BIC1' },
        ],
      },
      { title: '', category: 'Dashlane payment', fields: [] },
    ]);
  });

  it('reads a passport, license, SSN or ID card as a Document, any other ID under its type', () => {
    expect(
      parse(
        'ids.csv',
        'type,number,name,issue_date,expiration_date,place_of_issue,note',
        'passport,P12345,Alice Smith,2020-01-01,2030-01-01,USA,renew',
        'card,C9,,,,,',
        'tax_number,T1,,,,,',
        ',,,,,,',
      ).items,
    ).toEqual([
      {
        title: 'Alice Smith',
        template: 'document',
        fields: [
          { key: 'Document type', value: 'Passport', role: 'documentType' },
          { key: 'Number', value: 'P12345', role: 'number' },
          { key: 'Name', value: 'Alice Smith', role: 'fullName' },
          { key: 'Place of issue', value: 'USA', role: 'issuer' },
          { key: 'Issue date', value: '2020-01-01', role: 'issueDate' },
          { key: 'Expiration date', value: '2030-01-01', role: 'expiryDate' },
        ],
        notes: 'renew',
      },
      {
        title: 'C9',
        template: 'document',
        fields: [
          { key: 'Document type', value: 'ID card', role: 'documentType' },
          { key: 'Number', value: 'C9', role: 'number' },
        ],
      },
      { title: 'T1', category: 'Dashlane tax_number', fields: [{ key: 'Number', value: 'T1' }] },
      { title: '', category: 'Dashlane ID', fields: [] },
    ]);
    const kinds = ['license', 'social_security'].map(
      (type) => parse('ids.csv', 'type,number', `${type},1`).items[0]?.fields[0]?.value,
    );
    expect(kinds).toEqual(["Driver's License", 'Social Security Number']);
  });

  it('reads personal info as an identity, titled by item name or the full name', () => {
    expect(
      parse(
        'personalInfo.csv',
        'type,title,first_name,last_name,email,phone_number,address,city,item_name,note',
        'name,Ms,Alice,Smith,a@b.com,555,1 Main St,NYC,,n',
        'email,,,,c@d.com,,,,Work mail,',
      ).items,
    ).toEqual([
      {
        title: 'Alice Smith',
        template: 'identity',
        fields: [
          { key: 'First name', value: 'Alice', role: 'firstName' },
          { key: 'Last name', value: 'Smith', role: 'lastName' },
          { key: 'Email', value: 'a@b.com', role: 'email' },
          { key: 'Phone', value: '555', role: 'phone' },
          { key: 'Address', value: '1 Main St', role: 'address' },
          { key: 'Type', value: 'name' },
          { key: 'Title', value: 'Ms' },
          { key: 'City', value: 'NYC' },
        ],
        notes: 'n',
      },
      {
        title: 'Work mail',
        template: 'identity',
        fields: [
          { key: 'Email', value: 'c@d.com', role: 'email' },
          { key: 'Type', value: 'email' },
        ],
      },
    ]);
  });

  it('reads a secure note, its text as notes', () => {
    expect(
      parse('securenotes.csv', 'title,note,category', 'Key,important,Home', 'Short').items,
    ).toEqual([
      {
        title: 'Key',
        template: 'secure-note',
        fields: [{ key: 'Category', value: 'Home' }],
        notes: 'important',
      },
      { title: 'Short', template: 'secure-note', fields: [] },
    ]);
  });

  it('reads every CSV it knows, by name in any case or directory, and ignores the others', () => {
    const result = parseDashlaneExport(
      zip({
        'export/Dashlane-Credentials-20260101.csv': 'username,title,password\nalice,X,secret',
        'securenotes.csv': 'title,note\nN,body',
        'unrelated.csv': 'a,b\n1,2',
        'credentials.txt': 'username,title,password\nz,TXT,pw',
        'credentials/unrelated.csv': 'username,title,password\nz,DIR,pw',
        'payments.csv': '',
      }),
    );
    expect(result.items.map((i) => i.title)).toEqual(['X', 'N']);
    expect(result.skipped).toBe(0);
  });

  it('refuses an archive beyond the entry cap (D130)', () => {
    const files = Object.fromEntries(
      Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, i) => [`f${String(i)}`, new Uint8Array()]),
    );
    refused(zipSync(files), 'too-large');
  });

  it('refuses a zip with none of its CSVs, and a file that is not a zip', () => {
    refused(zip({ 'unrelated.csv': 'a,b' }), 'not-this-format');
    refused(zipSync({}), 'not-this-format');
    refused(strToU8('username,password'), 'not-this-format');
  });
});
