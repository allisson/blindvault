import { initCrypto } from '@blindvault/crypto';
import { type Item, TITLE_MAX, itemToCbor, readItem, template } from '@blindvault/vault';
import { beforeAll, describe, expect, it } from 'vitest';

import { type Draft, type DraftField, addField, draftOf, inputOf, newDraft } from './item-draft';

beforeAll(async () => {
  await initCrypto();
});

function login(): Draft {
  const t = template('login');
  if (!t) throw new Error('no login template');
  return newDraft(t);
}

function set(draft: Draft, role: string, value: string): Draft {
  return {
    ...draft,
    fields: draft.fields.map((f) => (f.role === role ? { ...f, value } : f)),
  };
}

function ok(draft: Draft) {
  const result = inputOf(draft);
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.errors)}`);
  return result.input;
}

function errors(draft: Draft) {
  const result = inputOf(draft);
  if (result.ok) throw new Error('accepted');
  return result.errors;
}

function last(draft: Draft): DraftField {
  const f = draft.fields.at(-1);
  if (!f) throw new Error('no field');
  return f;
}

const SEED = `${'abandon '.repeat(11)}about`;

describe('item drafts (record-content.md §3, §4)', () => {
  it('starts a new item with the template roles, in order, empty', () => {
    const draft = login();
    expect(draft.templateId).toBe('login');
    expect(draft.fields.map((f) => [f.role, f.type, f.value])).toEqual([
      ['username', 'text', ''],
      ['password', 'secret', ''],
      ['url', 'url', ''],
    ]);
  });

  it('writes the filled fields only, with a trimmed title and normalized tags', () => {
    let draft = { ...login(), title: '  Bank  ', tags: ' work, Bank ,bank,, ', notes: '' };
    draft = set(set(draft, 'username', ' ana '), 'password', ' p w ');
    const input = ok(draft);
    expect(input.title).toBe('Bank');
    expect(input.tags).toEqual(['Bank', 'work']);
    expect(input.notes).toBeUndefined();
    expect(input.fields).toEqual([
      { type: 'text', role: 'username', value: 'ana' },
      // A secret is stored as typed: spaces may belong to it.
      { type: 'secret', role: 'password', value: ' p w ' },
    ]);
    // What the session would write reads back as valid.
    expect(readItem(itemToCbor(input, false), false).readOnly).toBe(false);
  });

  it('keeps a multi-line secret and notes as typed', () => {
    const t = template('developer-credential');
    if (!t) throw new Error('no template');
    const draft = { ...newDraft(t), title: 'API', notes: 'line 1\nline 2' };
    const input = ok(set(draft, 'secret', '-----BEGIN-----\nabc\n-----END-----'));
    expect(input.fields[0]?.value).toBe('-----BEGIN-----\nabc\n-----END-----');
    expect(input.notes).toBe('line 1\nline 2');
  });

  it('refuses an empty or too long title', () => {
    expect(errors({ ...login(), title: ' \t ' }).title).toBe('required');
    expect(errors({ ...login(), title: 'x'.repeat(TITLE_MAX + 1) }).title).toBe('too-long');
    // Code points, not UTF-16 units.
    expect(inputOf({ ...login(), title: '\u{1F600}'.repeat(TITLE_MAX) }).ok).toBe(true);
  });

  it('refuses a custom field with a value and no label, and drops an empty one', () => {
    let draft = { ...login(), title: 'x' };
    draft = addField(draft, 'text');
    const added = last(draft);
    expect(ok(draft).fields).toEqual([]);
    const filled = {
      ...draft,
      fields: draft.fields.map((f) => (f.key === added.key ? { ...f, value: 'v' } : f)),
    };
    expect(errors(filled).fields.get(added.key)).toBe('label-required');
    const labelled = {
      ...filled,
      fields: filled.fields.map((f) => (f.key === added.key ? { ...f, label: ' PIN ' } : f)),
    };
    expect(ok(labelled).fields).toEqual([{ type: 'text', label: 'PIN', value: 'v' }]);
    const long = {
      ...filled,
      fields: filled.fields.map((f) =>
        f.key === added.key ? { ...f, label: 'l'.repeat(129) } : f,
      ),
    };
    expect(errors(long).fields.get(added.key)).toBe('label-too-long');
  });

  it.each([
    ['date', 'birthDate', 'identity', '2024-02-30', 'date'],
    ['month-precision date', 'expiry', 'card', '2027-05-01', 'month'],
    ['seed phrase', 'seedPhrase', 'crypto-wallet', 'abandon abandon', 'seed-phrase'],
  ])('refuses an invalid %s', (_name, role, templateId, value, code) => {
    const t = template(templateId);
    if (!t) throw new Error('no template');
    const draft = set({ ...newDraft(t), title: 'x' }, role, value);
    const key = draft.fields.find((f) => f.role === role)?.key;
    expect(errors(draft).fields.get(key ?? -1)).toBe(code);
  });

  it('refuses an invalid number in a custom field', () => {
    const draft = addField({ ...login(), title: 'x' }, 'number');
    const added = last(draft);
    const bad = {
      ...draft,
      fields: draft.fields.map((f) =>
        f.key === added.key ? { ...f, label: 'n', value: '1e5' } : f,
      ),
    };
    expect(errors(bad).fields.get(added.key)).toBe('number');
    const good = {
      ...bad,
      fields: bad.fields.map((f) => (f.key === added.key ? { ...f, value: '007.50' } : f)),
    };
    expect(ok(good).fields).toEqual([{ type: 'number', label: 'n', value: '007.50' }]);
  });

  it('accepts month and day dates, and normalizes a typed seed phrase', () => {
    const card = template('card');
    const wallet = template('crypto-wallet');
    if (!card || !wallet) throw new Error('no template');
    expect(ok(set({ ...newDraft(card), title: 'c' }, 'expiry', '2027-05')).fields).toEqual([
      { type: 'date', role: 'expiry', value: '2027-05' },
    ]);
    const typed = `  ${SEED.toUpperCase().replaceAll(' ', '  ')} `;
    expect(ok(set({ ...newDraft(wallet), title: 'w' }, 'seedPhrase', typed)).fields).toEqual([
      { type: 'seed-phrase', role: 'seedPhrase', value: SEED },
    ]);
  });

  it('refuses more than 32 tags or a tag longer than 64 code points', () => {
    const many = Array.from({ length: 33 }, (_, i) => `t${String(i)}`).join(',');
    expect(errors({ ...login(), title: 'x', tags: many }).tags).toBe('too-many');
    expect(errors({ ...login(), title: 'x', tags: 'a'.repeat(65) }).tags).toBe('too-long');
  });

  it('edits an item without changing it when nothing is touched (D165)', () => {
    const item: Item = {
      templateId: 'login',
      templateVersion: 1,
      title: 'Bank',
      fields: [
        { type: 'secret', role: 'password', value: 'pw' },
        { type: 'text', label: 'Branch', value: '0001' },
        {
          type: 'totp',
          label: '2FA',
          value: { secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30 },
        },
      ],
      tags: ['a', 'b'],
      notes: 'n',
      folderId: new Uint8Array(16).fill(7),
    };
    const draft = draftOf(item);
    // The roles the item does not hold come after its own fields, empty.
    expect(draft.fields.map((f) => f.role ?? f.label)).toEqual([
      'password',
      'Branch',
      '2FA',
      'username',
      'url',
    ]);
    const input = ok(draft);
    expect(input).toEqual(item);
    expect(itemToCbor(input, false)).toEqual(itemToCbor(item, false));
  });

  it('stores a value that reads like an error code as typed', () => {
    const draft = set({ ...login(), title: 'x' }, 'username', ' number ');
    expect(ok(draft).fields).toEqual([{ type: 'text', role: 'username', value: 'number' }]);
  });

  it('refuses a line break in a single-line field', () => {
    const draft = set({ ...login(), title: 'x' }, 'url', 'https://a\nb');
    const key = draft.fields.find((f) => f.role === 'url')?.key;
    expect(errors(draft).fields.get(key ?? -1)).toBe('single-line');
  });

  it('moves an item to the vault root when its folder is cleared', () => {
    const draft = { ...login(), title: 'x', folderId: new Uint8Array(16).fill(3) };
    expect(ok(draft).folderId).toEqual(new Uint8Array(16).fill(3));
    expect(ok({ ...draft, folderId: undefined })).not.toHaveProperty('folderId');
  });

  it('gives every field its own key', () => {
    const draft = addField(addField(login(), 'text'), 'secret');
    expect(new Set(draft.fields.map((f) => f.key)).size).toBe(draft.fields.length);
  });
});
