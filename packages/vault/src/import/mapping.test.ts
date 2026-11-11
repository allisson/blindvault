import {
  ITEM_CAP,
  initCrypto,
  itemContentLength,
  parseOtpauthUri,
  parseTotpSecret,
} from '@blindvault/crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import { itemToCbor } from '../item';
import { mapImport } from './mapping';
import type { SourceField, SourceItem } from './source';

beforeAll(initCrypto);

const URI = 'otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub';
const PHRASE = Array.from({ length: 11 }, () => 'abandon').join(' ') + ' about';

function one(source: Partial<SourceItem>) {
  const mapped = mapImport({ items: [{ title: 'T', fields: [], ...source }], skipped: 0 });
  const [first] = mapped.items;
  if (!first) throw new Error('skipped');
  return first.item;
}

const fields = (template: string, ...f: SourceField[]) => one({ template, fields: f }).fields;

describe('import mapping (D124, D131, D133, D242)', () => {
  it('fills the template roles, with no label', () => {
    expect(
      one({
        title: 'GitHub',
        template: 'login',
        fields: [
          { key: 'Username', value: 'alice', role: 'username' },
          { key: 'Password', value: 'hunter2', role: 'password' },
          { key: 'URL', value: 'https://github.com', role: 'url' },
          { key: 'Recovery codes', value: 'a\nb' },
          { key: 'Plan', value: 'pro' },
        ],
      }),
    ).toEqual({
      templateId: 'login',
      templateVersion: 1,
      title: 'GitHub',
      fields: [
        { type: 'text', value: 'alice', role: 'username' },
        { type: 'secret', value: 'hunter2', role: 'password' },
        { type: 'url', value: 'https://github.com', role: 'url' },
        { type: 'long-text', value: 'a\nb', label: 'Recovery codes' },
        { type: 'text', value: 'pro', label: 'Plan' },
      ],
      tags: [],
    });
  });

  it('keeps an otpauth URI as a totp field under any key, a bare secret only under a TOTP key', () => {
    expect(
      fields(
        'login',
        { key: 'TOTP', value: URI },
        { key: 'Password', value: URI, role: 'password' },
        { key: 'One-time password', value: 'jbsw y3dp' },
        { key: '2FA', value: 'JBSWY3DP' },
        { key: 'Password', value: 'JBSWY3DPEHPK3PXP', role: 'password' },
        { key: 'Word', value: 'JBSWY3DP' },
        { key: 'TOTP', value: 'not a secret!' },
        { key: 'Backup otp', value: 'otpauth://totp/x?secret=1' },
      ),
    ).toEqual([
      { type: 'totp', value: parseOtpauthUri(URI), label: 'TOTP' },
      { type: 'totp', value: parseOtpauthUri(URI), label: 'Password' },
      { type: 'totp', value: parseTotpSecret('JBSWY3DP'), label: 'One-time password' },
      { type: 'totp', value: parseTotpSecret('JBSWY3DP'), label: '2FA' },
      { type: 'secret', value: 'JBSWY3DPEHPK3PXP', role: 'password' },
      { type: 'text', value: 'JBSWY3DP', label: 'Word' },
      { type: 'secret', value: 'not a secret!', label: 'TOTP' },
      { type: 'secret', value: 'otpauth://totp/x?secret=1', label: 'Backup otp' },
    ]);
  });

  it('keeps a secret-looking key as a secret field, never dropped', () => {
    const keys = [
      'API secret',
      'recoveryPhrase',
      'Private-Key',
      'Mnemonic',
      'PIN',
      'card_cvc',
      'cvv',
      'totpKey',
    ];
    expect(fields('login', ...keys.map((key) => ({ key, value: 'v' }))).map((f) => f.type)).toEqual(
      keys.map(() => 'secret'),
    );
    expect(fields('login', { key: 'Pinterest', value: 'v' }, { key: 'Spin', value: 'v' })).toEqual([
      { type: 'text', value: 'v', label: 'Pinterest' },
      { type: 'text', value: 'v', label: 'Spin' },
    ]);
  });

  it('keeps a hidden field as a secret, a role only when the role is masked (D242)', () => {
    expect(
      fields(
        'card',
        { key: 'Badge', value: 'B-1', hidden: true },
        { key: 'Cardholder', value: 'Alice', role: 'cardholder', hidden: true },
        { key: 'CVV', value: '123', role: 'cvv', hidden: true },
      ),
    ).toEqual([
      { type: 'secret', value: 'B-1', label: 'Badge' },
      { type: 'secret', value: 'Alice', label: 'Cardholder' },
      { type: 'secret', value: '123', role: 'cvv' },
    ]);
  });

  it('keeps a value that fails its role as a field under its source label (D242)', () => {
    expect(
      fields(
        'identity',
        { key: 'Email', value: 'a@b.com\nc@d.com', role: 'email' },
        { key: 'Birthday', value: '31/12/1990', role: 'birthDate' },
        { key: 'Birth date', value: '1990-12-31', role: 'birthDate' },
        { key: 'Phone', value: '1', role: 'phone' },
        { key: 'Phone', value: '2', role: 'phone' },
        { key: 'Password', value: 'p', role: 'nope' },
        { key: 'Address', value: '1 Main\nNYC', role: 'address' },
      ),
    ).toEqual([
      { type: 'long-text', value: 'a@b.com\nc@d.com', label: 'Email' },
      { type: 'text', value: '31/12/1990', label: 'Birthday' },
      { type: 'date', value: '1990-12-31', role: 'birthDate' },
      { type: 'phone', value: '1', role: 'phone' },
      { type: 'text', value: '2', label: 'Phone' },
      { type: 'secret', value: 'p', label: 'Password' },
      { type: 'long-text', value: '1 Main\nNYC', role: 'address' },
    ]);
    expect(
      fields(
        'card',
        { key: 'Expiry', value: '2027-03-01', role: 'expiry' },
        { key: 'Expiry', value: '2027-03', role: 'expiry' },
      ),
    ).toEqual([
      { type: 'text', value: '2027-03-01', label: 'Expiry' },
      { type: 'date', value: '2027-03', role: 'expiry' },
    ]);
  });

  it('keeps a seed phrase outside the word list as a secret, and normalizes a valid one', () => {
    expect(
      fields(
        'crypto-wallet',
        { key: 'Words', value: 'abandon ability able', role: 'seedPhrase' },
        {
          key: 'Words',
          value: `  ${PHRASE.toUpperCase().replace(/ /g, '\n')} `,
          role: 'seedPhrase',
        },
      ),
    ).toEqual([
      { type: 'secret', value: 'abandon ability able', label: 'Words' },
      { type: 'seed-phrase', value: PHRASE, role: 'seedPhrase' },
    ]);
  });

  it('turns a category with no template into a Secure Note titled [Category] Title', () => {
    const mapped = mapImport({
      items: [
        {
          title: 'Chase',
          category: 'Bank Account',
          fields: [{ key: 'Number', value: '12', role: 'number' }],
          folder: ['Bank'],
        },
        { title: ' ', category: 'Wifi', fields: [] },
        { title: 'Odd', template: 'unknown', fields: [] },
        { title: 'Login', template: 'login', fields: [] },
      ],
      skipped: 2,
    });
    expect(mapped.items[0]).toEqual({
      item: {
        templateId: 'secure-note',
        templateVersion: 1,
        title: '[Bank Account] Chase',
        fields: [{ type: 'text', value: '12', label: 'Number' }],
        tags: [],
      },
      folder: ['Bank'],
    });
    expect(mapped.items.map((m) => [m.item.templateId, m.item.title, m.folder])).toEqual([
      ['secure-note', '[Bank Account] Chase', ['Bank']],
      ['secure-note', '[Wifi] Untitled', []],
      ['secure-note', 'Odd', []],
      ['login', 'Login', []],
    ]);
    expect(mapped).toMatchObject({ skipped: 2, attachments: 0, notes: 3 });
  });

  it('keeps a passport category matched by its parser as a Document (D242)', () => {
    expect(
      fields(
        'document',
        { key: 'Document type', value: 'Passport', role: 'documentType' },
        { key: 'Expiration date', value: 'never', role: 'expiryDate' },
      ),
    ).toEqual([
      { type: 'text', value: 'Passport', role: 'documentType' },
      { type: 'text', value: 'never', label: 'Expiration date' },
    ]);
  });

  it('cuts a title or label to its limit, and gives blank ones a name (D242)', () => {
    const long = '😀'.repeat(600);
    const item = one({
      title: ` ${long}\nmore `,
      template: 'login',
      fields: [
        { key: 'é'.repeat(200), value: 'v' },
        { key: ' \n ', value: 'v' },
        { key: 'a\r\nb ', value: 'v' },
      ],
    });
    expect(item.title).toBe('😀'.repeat(512));
    expect(item.fields.map((f) => f.label)).toEqual(['é'.repeat(128), 'Field', 'a b']);
    expect(one({ title: '\n' }).title).toBe('Untitled');
    expect(one({ title: 'x', category: 'c'.repeat(600) }).title).toBe(`[${'c'.repeat(511)}`);
  });

  it('keeps the first 32 valid tags, naming the rest and the invalid ones in the notes', () => {
    const tags = Array.from({ length: 34 }, (_, i) => `t${String(i).padStart(2, '0')}`);
    const item = one({
      tags: [...tags, 'T00', ' ', 'x'.repeat(65), 'a\nb'],
      notes: 'mine',
    });
    expect(item.tags).toEqual(tags.slice(0, 32));
    expect(item.notes).toBe(`mine\n\n[More tags: ${'x'.repeat(65)}, a\nb, t32, t33]`);
  });

  it('drops attachments, counts them and names them in the notes (D124)', () => {
    const mapped = mapImport({
      items: [
        {
          title: 'a',
          template: 'login',
          fields: [],
          attachments: ['x.pdf', 'y.png'],
          tags: ['z'.repeat(65)],
        },
        { title: 'b', template: 'login', fields: [], attachments: ['c.txt'], notes: 'n' },
      ],
      skipped: 0,
    });
    expect(mapped.items.map((m) => m.item.notes)).toEqual([
      `[Lost attachments: x.pdf, y.png]\n\n[More tags: ${'z'.repeat(65)}]`,
      'n\n\n[Lost attachments: c.txt]',
    ]);
    expect(mapped).toMatchObject({ attachments: 3, notes: 0 });
  });

  it('skips and counts an item above the item cap, with its landing folder ID (D129, D139)', () => {
    const at = (notes: string): SourceItem => ({
      title: 'T',
      template: 'login',
      fields: [],
      notes,
    });
    const size = (n: number) =>
      itemContentLength(
        itemToCbor(
          {
            ...{ templateId: 'login', templateVersion: 1, title: 'T', fields: [], tags: [] },
            notes: 'x'.repeat(n),
            folderId: new Uint8Array(16),
          },
          false,
        ),
      );
    // The longest notes that keep the placed item at the cap.
    let n = ITEM_CAP - (size(1000) - 1000);
    n -= size(n) - ITEM_CAP;
    expect(size(n)).toBe(ITEM_CAP);
    const edge = mapImport({
      items: [at('x'.repeat(n)), at('x'.repeat(n + 1))],
      skipped: 1,
    });
    expect(edge.items).toHaveLength(1);
    expect(edge).toMatchObject({ skipped: 2, attachments: 0 });
    const lost = mapImport({
      items: [{ ...at('x'.repeat(ITEM_CAP)), category: 'c', attachments: ['a'] }],
      skipped: 0,
    });
    expect(lost).toMatchObject({ items: [], skipped: 1, attachments: 0, notes: 0 });
  });

  it('leaves out an empty value', () => {
    expect(fields('login', { key: 'Username', value: '', role: 'username' })).toEqual([]);
  });
});
