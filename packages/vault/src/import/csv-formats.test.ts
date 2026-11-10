import { describe, expect, it } from 'vitest';

import { ImportRejectedError } from '../errors';
import {
  parseApplePasswordsCsv,
  parseChromeCsv,
  parseKeePassXcCsv,
  parseLastPassCsv,
} from './csv-formats';

// Adapted from BlindPass's parser tests (`apps/web/src/lib/import/__tests__/`): the same rows,
// read into source items instead of BlindPass items.

const login = (title: string, username: string, password: string, url?: string) => ({
  title,
  template: 'login',
  fields: [
    { key: 'Username', value: username, role: 'username' },
    { key: 'Password', value: password, role: 'password' },
    ...(url ? [{ key: 'URL', value: url, role: 'url' }] : []),
  ],
});

function refused(parse: () => unknown) {
  expect(parse).toThrow(ImportRejectedError);
  try {
    parse();
  } catch (e) {
    expect((e as ImportRejectedError).reason).toBe('missing-columns');
  }
}

describe('Chrome CSV', () => {
  const HEADER = 'name,url,username,password,note';

  it('reads a login with its note', () => {
    const { items, skipped } = parseChromeCsv(
      `${HEADER}\r\nGoogle,https://google.com,user@gmail.com,pass123,my note`,
    );
    expect(items).toEqual([
      { ...login('Google', 'user@gmail.com', 'pass123', 'https://google.com'), notes: 'my note' },
    ]);
    expect(skipped).toBe(0);
  });

  it('skips and counts rows with no password, short rows included', () => {
    const csv = [HEADER, 'A,https://a.com,u,p,', 'B,https://b.com,u,,', 'C,https://c.com'].join(
      '\n',
    );
    const { items, skipped } = parseChromeCsv(csv);
    expect(items.map((i) => i.title)).toEqual(['A']);
    expect(skipped).toBe(2);
  });

  it('leaves out empty values', () => {
    expect(parseChromeCsv(`${HEADER}\nLocal,,,secret,`).items).toEqual([
      {
        title: 'Local',
        template: 'login',
        fields: [{ key: 'Password', value: 'secret', role: 'password' }],
      },
    ]);
  });

  it('keeps quoted commas and quotes', () => {
    const { items } = parseChromeCsv(`${HEADER}\n"It""s Mine","","u","p@ss,word",""`);
    expect(items[0]).toEqual(login('It"s Mine', 'u', 'p@ss,word'));
  });

  it('titles a nameless login by its URL host, else its URL (Firefox columns)', () => {
    const csv = [
      'url,username,password,httpRealm,formActionOrigin,guid',
      'https://github.com/login,u,p,,https://github.com,{}',
      'not-a-url,u,p,,,',
      'file:///home/site,u,p,,,',
      ',u,p,,,',
    ].join('\n');
    expect(parseChromeCsv(csv).items.map((i) => i.title)).toEqual([
      'github.com',
      'not-a-url',
      'file:///home/site',
      '',
    ]);
  });

  it('reads a header-only file as no items', () => {
    expect(parseChromeCsv(HEADER)).toEqual({ items: [], skipped: 0 });
  });

  it('refuses a file without the username and password columns, or without a header', () => {
    refused(() => parseChromeCsv('name,url\nGoogle,https://google.com'));
    refused(() => parseChromeCsv(''));
  });
});

describe('LastPass CSV', () => {
  const HEADER = 'url,username,password,totp,extra,name,grouping,fav';

  it('reads a login with its TOTP, note and nested folder', () => {
    const { items } = parseLastPassCsv(
      `${HEADER}\nhttps://google.com,u,p,JBSWY3DP,extra note,Google,Personal\\Mail,0`,
    );
    expect(items).toEqual([
      {
        ...login('Google', 'u', 'p', 'https://google.com'),
        fields: [
          ...login('Google', 'u', 'p', 'https://google.com').fields,
          { key: 'TOTP', value: 'JBSWY3DP' },
        ],
        notes: 'extra note',
        folder: ['Personal', 'Mail'],
      },
    ]);
  });

  it('keeps a secure note as a note, with or without a password (BlindPass skipped it)', () => {
    const csv = [
      HEADER,
      'http://sn,,,,"line 1\nline 2",My Note,Notes,0',
      'http://sn,,x,,,Empty,,0',
    ].join('\n');
    const { items, skipped } = parseLastPassCsv(csv);
    expect(items).toEqual([
      {
        title: 'My Note',
        template: 'secure-note',
        fields: [],
        notes: 'line 1\nline 2',
        folder: ['Notes'],
      },
      { title: 'Empty', template: 'secure-note', fields: [] },
    ]);
    expect(skipped).toBe(0);
  });

  it('skips and counts a login with no password', () => {
    expect(parseLastPassCsv(`${HEADER}\nhttps://a.com,u,,,,A,,0\nshort`)).toEqual({
      items: [],
      skipped: 2,
    });
  });

  it('refuses a file without a password column', () => {
    refused(() => parseLastPassCsv('url,username,name\nhttps://google.com,u,Google'));
  });
});

describe('Apple Passwords CSV', () => {
  const HEADER = 'Title,URL,Username,Password,Notes,OTPAuth';

  it('reads a login with its OTPAuth URI, through a BOM and CRLF', () => {
    const uri = 'otpauth://totp/GitHub:alice?secret=JBSW&issuer=GitHub';
    const { items } = parseApplePasswordsCsv(
      `\uFEFF${HEADER}\r\nGitHub,https://github.com,alice,secret,"line 1\nline 2",${uri}`,
    );
    expect(items).toEqual([
      {
        title: 'GitHub',
        template: 'login',
        fields: [
          ...login('GitHub', 'alice', 'secret', 'https://github.com').fields,
          { key: 'OTPAuth', value: uri },
        ],
        notes: 'line 1\nline 2',
      },
    ]);
  });

  it('finds columns in any order and case', () => {
    expect(
      parseApplePasswordsCsv('PASSWORD,USERNAME,URL,TITLE\nsecret,alice,https://x.com,X').items,
    ).toEqual([login('X', 'alice', 'secret', 'https://x.com')]);
  });

  it('skips a row with no password and refuses a file without the password column', () => {
    expect(parseApplePasswordsCsv(`${HEADER}\nFoo,https://foo,alice,,,`)).toEqual({
      items: [],
      skipped: 1,
    });
    refused(() => parseApplePasswordsCsv('Title,URL,Username,Notes\nFoo,https://foo,alice,'));
  });
});

describe('KeePassXC CSV', () => {
  const HEADER =
    '"Group","Title","Username","Password","URL","Notes","TOTP","Icon","Last Modified","Created"';

  it('reads a login with its group as the folder (BlindPass dropped it) and its TOTP', () => {
    const { items } = parseKeePassXcCsv(
      `${HEADER}\n"Root/Web","GitHub","alice","secret","https://github.com","n","JBSW","48","2024-01-01","2023-01-01"`,
    );
    expect(items).toEqual([
      {
        title: 'GitHub',
        template: 'login',
        fields: [
          ...login('GitHub', 'alice', 'secret', 'https://github.com').fields,
          { key: 'TOTP', value: 'JBSW' },
        ],
        notes: 'n',
        folder: ['Root', 'Web'],
      },
    ]);
  });

  it('skips a row with no password and refuses a file without the password column', () => {
    expect(parseKeePassXcCsv(`${HEADER}\n"","Foo","alice","","","","","","",""`)).toEqual({
      items: [],
      skipped: 1,
    });
    refused(() => parseKeePassXcCsv('"Group","Title"\n"Root","Foo"'));
  });
});
