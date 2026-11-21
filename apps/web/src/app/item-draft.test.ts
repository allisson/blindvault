import { initCrypto, openBlob } from '@blindvault/crypto';
import {
  type AttachmentValue,
  ContentInvalidError,
  type Item,
  TITLE_MAX,
  itemToCbor,
  readItem,
  template,
} from '@blindvault/vault';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  type Draft,
  type DraftField,
  addAttachment,
  addField,
  draftChanged,
  draftOf,
  inputOf,
  newDraft,
  sealFiles,
} from './item-draft';

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

  it('keeps "Match the whole domain" on a url field through an edit (extension.md §5.4)', () => {
    const item: Item = {
      templateId: 'login',
      templateVersion: 1,
      title: 'Example',
      fields: [
        { type: 'url', role: 'url', value: 'https://example.com', match: 'domain' },
        { type: 'url', label: 'Other', value: 'https://example.org' },
      ],
      tags: [],
    };
    const draft = draftOf(item);
    expect(draft.fields.map((f) => f.matchDomain ?? false)).toEqual([true, false, false, false]);
    expect(ok(draft)).toEqual(item);

    const off = { ...draft, fields: draft.fields.map((f) => ({ ...f, matchDomain: false })) };
    expect(draftChanged(draft, off)).toBe(true);
    expect(ok(off).fields.some((f) => 'match' in f)).toBe(false);
    const on = { ...draft, fields: draft.fields.map((f) => ({ ...f, matchDomain: true })) };
    expect(draftChanged(draft, on)).toBe(true);
    expect(ok(on).fields.map((f) => f.match)).toEqual(['domain', 'domain']);
  });

  it('writes the match key on a url field only', () => {
    const draft = { ...set(login(), 'username', 'alice'), title: 'Example' };
    const flagged = { ...draft, fields: draft.fields.map((f) => ({ ...f, matchDomain: true })) };
    expect(ok(flagged).fields.some((f) => 'match' in f)).toBe(false);
  });

  it('keeps an attachment field as it is, with or without a label (D278)', () => {
    const value = {
      name: 'scan.pdf',
      size: 1,
      mediaType: 'application/pdf',
      blobId: new Uint8Array(32).fill(1),
      key: new Uint8Array(32).fill(2),
    };
    const item: Item = {
      templateId: 'secure-note',
      templateVersion: 1,
      title: 'Lease',
      fields: [
        { type: 'attachment', value },
        { type: 'attachment', label: 'Signed', value: { ...value, name: 'signed.pdf' } },
      ],
      tags: [],
    };
    const draft = draftOf(item);
    expect(draft.fields.map((f) => f.attachment)).toEqual(item.fields.map((f) => f.value));
    expect(draftChanged(draft, draft)).toBe(false);
    expect(ok(draft)).toEqual(item);
    // Relabeling keeps the file; a new value object is a change.
    const relabeled = {
      ...draft,
      fields: draft.fields.map((f, i) => (i === 1 ? { ...f, label: 'Lease, signed' } : f)),
    };
    expect(ok(relabeled).fields[1]).toEqual({
      type: 'attachment',
      label: 'Lease, signed',
      value: { ...value, name: 'signed.pdf' },
    });
    const replaced = {
      ...draft,
      fields: draft.fields.map((f, i) => (i === 0 ? { ...f, attachment: { ...value } } : f)),
    };
    expect(draftChanged(draft, replaced)).toBe(true);
    // Removed from the draft: not written.
    expect(ok({ ...draft, fields: draft.fields.slice(1) }).fields).toHaveLength(1);
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

  describe('TOTP fields (D127, record-content.md §4)', () => {
    function withTotp(value: string, label = '2FA'): { draft: Draft; key: number } {
      const draft = addField({ ...login(), title: 'x' }, 'totp');
      const added = last(draft);
      return {
        key: added.key,
        draft: {
          ...draft,
          fields: draft.fields.map((f) => (f.key === added.key ? { ...f, label, value } : f)),
        },
      };
    }

    it('parses an otpauth:// URI into the stored map, without the URI', () => {
      const { draft } = withTotp(
        ' otpauth://totp/ACME:ana@acme.example?secret=jbsw y3dp&issuer=ACME&digits=8&period=60 ',
      );
      expect(ok(draft).fields).toEqual([
        {
          type: 'totp',
          label: '2FA',
          value: {
            secret: 'JBSWY3DP',
            algorithm: 'SHA1',
            digits: 8,
            period: 60,
            issuer: 'ACME',
            accountName: 'ana@acme.example',
          },
        },
      ]);
    });

    it('parses a bare secret, normalized, with the defaults written', () => {
      const { draft } = withTotp('jbsw y3dp ehpk 3pxp');
      expect(ok(draft).fields).toEqual([
        {
          type: 'totp',
          label: '2FA',
          value: { secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30 },
        },
      ]);
    });

    it.each([
      ['a secret outside base32', 'JBSW1Y3DP'],
      ['an unknown algorithm', 'otpauth://totp/x?secret=JBSWY3DP&algorithm=MD5'],
      ['too few digits', 'otpauth://totp/x?secret=JBSWY3DP&digits=4'],
      ['a period out of range', 'otpauth://totp/x?secret=JBSWY3DP&period=5'],
      ['an HOTP URI', 'otpauth://hotp/x?secret=JBSWY3DP&counter=1'],
      ['a URI with no secret', 'otpauth://totp/x?issuer=ACME'],
    ])('refuses %s', (_name, value) => {
      const { draft, key } = withTotp(value);
      expect(errors(draft).fields.get(key)).toBe('totp');
    });

    it('refuses a TOTP field with no label, like any custom field', () => {
      const { draft, key } = withTotp('JBSWY3DP', '');
      expect(errors(draft).fields.get(key)).toBe('label-required');
    });

    it('drops an empty new TOTP field', () => {
      expect(ok(withTotp('').draft).fields).toEqual([]);
    });

    it('keeps the stored value when nothing is typed, and replaces it when something is', () => {
      const stored = {
        secret: 'JBSWY3DPEHPK3PXP',
        algorithm: 'SHA256',
        digits: 7,
        period: 45,
      } as const;
      const item: Item = {
        templateId: 'login',
        templateVersion: 1,
        title: 'x',
        fields: [{ type: 'totp', label: '2FA', value: stored }],
        tags: [],
      };
      const draft = draftOf(item);
      expect(ok(draft).fields).toEqual(item.fields);
      const replaced = {
        ...draft,
        fields: draft.fields.map((f) => (f.type === 'totp' ? { ...f, value: 'MFRGGZDF' } : f)),
      };
      expect(ok(replaced).fields).toEqual([
        {
          type: 'totp',
          label: '2FA',
          value: { secret: 'MFRGGZDF', algorithm: 'SHA1', digits: 6, period: 30 },
        },
      ]);
      // A refused replacement never falls back to the stored value silently.
      const bad = {
        ...draft,
        fields: draft.fields.map((f) => (f.type === 'totp' ? { ...f, value: '0189' } : f)),
      };
      expect(inputOf(bad).ok).toBe(false);
    });
  });

  it('tells a changed draft from the one opened (D234)', () => {
    const draft = login();
    expect(draftChanged(draft, draft)).toBe(false);
    expect(draftChanged(draft, { ...draft, fields: [...draft.fields] })).toBe(false);
    expect(draftChanged(draft, { ...draft, title: 'x' })).toBe(true);
    expect(draftChanged(draft, { ...draft, notes: 'x' })).toBe(true);
    expect(draftChanged(draft, { ...draft, tags: 'x' })).toBe(true);
    expect(draftChanged(draft, { ...draft, folderId: new Uint8Array(16) })).toBe(true);
    expect(
      draftChanged(
        { ...draft, folderId: new Uint8Array(16) },
        { ...draft, folderId: new Uint8Array(16) },
      ),
    ).toBe(false);
    expect(draftChanged(draft, addField(draft, 'text'))).toBe(true);
    const typed = draft.fields.map((f, i) => (i === 0 ? { ...f, value: 'me' } : f));
    expect(draftChanged(draft, { ...draft, fields: typed })).toBe(true);
    const relabeled = draft.fields.map((f, i) => (i === 0 ? { ...f, label: 'Login' } : f));
    expect(draftChanged(draft, { ...draft, fields: relabeled })).toBe(true);
    expect(draftChanged(draft, { ...draft, fields: draft.fields.slice(1) })).toBe(true);
  });

  it('gives every field its own key', () => {
    const draft = addField(addField(login(), 'text'), 'secret');
    expect(new Set(draft.fields.map((f) => f.key)).size).toBe(draft.fields.length);
  });
});

describe('attachments picked in the editor (attachments.md §7, D278)', () => {
  function note(): Draft {
    const t = template('secure-note');
    if (!t) throw new Error('no secure-note template');
    return { ...newDraft(t), title: 'Lease' };
  }

  function file(bytes: number[], name = 'scan.pdf', type = 'application/pdf'): File {
    return new File([new Uint8Array(bytes)], name, { type });
  }

  it('adds a picked file as an attachment field with its own key, a change to the draft', () => {
    const draft = note();
    const picked = file([1, 2, 3]);
    const next = addAttachment(draft, picked);
    const added = next.fields.at(-1);
    expect(added).toMatchObject({ type: 'attachment', label: '', value: '', file: picked });
    expect(added?.role).toBeUndefined();
    expect(added?.attachment).toBeUndefined();
    expect(new Set(next.fields.map((f) => f.key)).size).toBe(next.fields.length);
    expect(draftChanged(draft, next)).toBe(true);
    // Another file in the same field is a change.
    const swapped = {
      ...next,
      fields: next.fields.map((f) => (f.key === added?.key ? { ...f, file: file([1, 2, 3]) } : f)),
    };
    expect(draftChanged(next, swapped)).toBe(true);
  });

  it('reads and seals each picked file only when sealed, and the sealed draft writes it', async () => {
    const draft = addAttachment(addAttachment(note(), file([1, 2, 3])), file([4], 'a.txt', ''));
    const labeled = {
      ...draft,
      fields: draft.fields.map((f, i) =>
        i === draft.fields.length - 1 ? { ...f, label: 'Key' } : f,
      ),
    };
    const { draft: sealed, blobs, keys } = await sealFiles(labeled);
    expect(blobs).toHaveLength(2);
    expect(keys).toHaveLength(2);
    const fields = ok(sealed).fields.filter((f) => f.type === 'attachment');
    expect(fields).toHaveLength(2);
    const [first, second] = fields.map((f) => f.value as AttachmentValue);
    expect(first).toMatchObject({ name: 'scan.pdf', size: 3, mediaType: 'application/pdf' });
    expect(second).toMatchObject({ name: 'a.txt', size: 1, mediaType: 'application/octet-stream' });
    expect(fields[1]?.label).toBe('Key');
    // Each blob matches its field, and opens to the file's bytes with its key.
    expect(blobs.map((b) => b.blobId)).toEqual([first?.blobId, second?.blobId]);
    const [key0] = keys;
    const [blob0] = blobs;
    if (!key0 || !blob0) throw new Error('nothing sealed');
    expect(openBlob(key0, 3, blob0.blob)).toEqual(new Uint8Array([1, 2, 3]));
    // The keys handed back are the ones in the sealed draft: wiping them wipes its values.
    for (const k of keys) k.fill(0);
    expect(first?.key).toEqual(new Uint8Array(32));
    expect(second?.key).toEqual(new Uint8Array(32));
    // The draft itself is untouched: a failed save seals its files again.
    expect(labeled.fields.filter((f) => f.attachment)).toHaveLength(0);
  });

  it('leaves a draft with no picked file as it is', async () => {
    const draft = draftOf({
      templateId: 'secure-note',
      templateVersion: 1,
      title: 'Lease',
      fields: [
        {
          type: 'attachment',
          value: {
            name: 'scan.pdf',
            size: 1,
            mediaType: 'application/pdf',
            blobId: new Uint8Array(32).fill(1),
            key: new Uint8Array(32).fill(2),
          },
        },
      ],
      tags: [],
    });
    const sealed = await sealFiles(draft);
    expect(sealed.draft).toBe(draft);
    expect(sealed.blobs).toEqual([]);
    expect(sealed.keys).toEqual([]);
  });

  it('refuses a picked file that became empty, wiping the keys it sealed before', async () => {
    const draft = addAttachment(addAttachment(note(), file([1])), file([]));
    const spy = vi.spyOn(Uint8Array.prototype, 'fill');
    await expect(sealFiles(draft)).rejects.toThrow(ContentInvalidError);
    // The first file's key was wiped: fill(0) ran on a 32-byte array.
    expect(
      spy.mock.contexts.some(
        (c) => c instanceof Uint8Array && c.length === 32 && c.every((b) => b === 0),
      ),
    ).toBe(true);
    spy.mockRestore();
  });

  it('refuses a picked file that can no longer be read', async () => {
    const unreadable = file([1]);
    vi.spyOn(unreadable, 'arrayBuffer').mockRejectedValue(
      new DOMException('gone', 'NotReadableError'),
    );
    await expect(sealFiles(addAttachment(note(), unreadable))).rejects.toThrow('gone');
  });
});
