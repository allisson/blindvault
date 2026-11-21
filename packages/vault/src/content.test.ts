import { beforeAll, describe, expect, it } from 'vitest';

import { type CborMap, type CborValue, encodeCbor, initCrypto } from '@blindvault/crypto';

import { ContentInvalidError } from './errors';
import { deviceToCbor, folderToCbor, readDevice } from './folder';
import {
  type Item,
  attachmentMediaType,
  attachmentName,
  citedBlobIds,
  isValidDate,
  isValidSeedPhrase,
  itemToCbor,
  normalizeSeedPhrase,
  normalizeTags,
  passkeyUserName,
  readItem,
  seedPhraseChecksumValid,
} from './item';
import { readLocalConfig, readLocalConfigEncrypted } from './local-config';
import { TEMPLATES, roleOf, template } from './templates';
import { codePointLength } from './text';

beforeAll(initCrypto);

const ID = new Uint8Array(16).fill(7);
const login: Item = {
  templateId: 'login',
  templateVersion: 1,
  title: 'Example',
  fields: [
    { type: 'text', role: 'username', value: 'alice' },
    {
      type: 'totp',
      label: 'Code',
      value: { secret: 'JBSWY3DP', algorithm: 'SHA1', digits: 6, period: 30, issuer: 'ACME' },
    },
  ],
  tags: ['a'],
};

const map = (entries: [string, CborValue][]): CborMap => new Map<CborValue, CborValue>(entries);

describe('templates (D20)', () => {
  it('defines every template at version 1 with unique roles', () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual([
      'login',
      'secure-note',
      'card',
      'identity',
      'developer-credential',
      'crypto-wallet',
      'document',
    ]);
    for (const t of TEMPLATES) {
      expect(t.version).toBe(1);
      expect(new Set(t.roles.map((r) => r.role)).size).toBe(t.roles.length);
    }
    expect(template('passkey')).toBeUndefined();
    const card = template('card');
    expect(card && roleOf(card, 'expiry')).toMatchObject({ type: 'date', monthPrecision: true });
  });
});

describe('item writes', () => {
  it('round-trips an item with a TOTP field and its optional keys', () => {
    const item: Item = { ...login, notes: 'n', folderId: ID, trashOperationId: ID };
    const reading = readItem(itemToCbor(item, true), true);
    expect(reading).toEqual({ readOnly: false, item });
  });

  it.each([
    ['an empty title', { ...login, title: '' }, false],
    ['unsorted tags', { ...login, tags: ['b', 'a'] }, false],
    ['trashOperationId on a live item', { ...login, trashOperationId: ID }, false],
    ['a trashed item without trashOperationId', login, true],
    [
      'an invalid TOTP',
      {
        ...login,
        fields: [
          { type: 'totp', label: 'x', value: { ...(login.fields[1]?.value as object), digits: 9 } },
        ],
      },
      false,
    ],
  ] as [string, Item, boolean][])('refuses %s', (_name, item, deleted) => {
    expect(() => itemToCbor(item, deleted)).toThrow(ContentInvalidError);
  });

  it('normalizes tags: NFC, trimmed, case-insensitive duplicates and empties dropped, code-point order', () => {
    expect(normalizeTags([' café ', 'Bank', 'bank', '', '　', '\u{1F600}', 'z', '�'])).toEqual([
      'Bank',
      'café',
      'z',
      '�',
      '\u{1F600}',
    ]);
  });

  it('orders astral tags by code point, not UTF-16 unit', () => {
    // U+FFFD sorts before U+1F600 by code point but after it by UTF-16 unit (0xD83D).
    const item = { ...login, tags: ['�', '\u{1F600}'] };
    expect(readItem(itemToCbor(item, false), false).readOnly).toBe(false);
    expect(
      readItem(
        map(
          [...itemToCbor(item, false)].map(([k, v]) => [
            k as string,
            k === 'tags' ? ['\u{1F600}', '�'] : v,
          ]),
        ),
        false,
      ),
    ).toEqual({ readOnly: true, rule: 6 });
  });

  it('normalizes seed-phrase input: NFKD, lowercase, one space between words (§4)', () => {
    const typed =
      '  Abandon\tabandon\n abandon abandon abandon abandon abandon abandon abandon abandon abandon ABOUT ';
    const value = normalizeSeedPhrase(typed);
    expect(value).toBe(`${'abandon '.repeat(11)}about`);
    expect(isValidSeedPhrase(value)).toBe(true);
    // A word outside the list stays invalid: normalizing never repairs a typo.
    expect(isValidSeedPhrase(normalizeSeedPhrase(`${'abandon '.repeat(11)}abuot`))).toBe(false);
    expect(normalizeSeedPhrase('   ')).toBe('');
  });

  it('reports a bad BIP39 checksum without refusing the value (§4)', () => {
    const bad = 'abandon '.repeat(11) + 'abandon';
    expect(isValidSeedPhrase(bad)).toBe(true);
    expect(seedPhraseChecksumValid(bad)).toBe(false);
    expect(seedPhraseChecksumValid(`${'abandon '.repeat(11)}about`)).toBe(true);
    expect(seedPhraseChecksumValid('not a phrase')).toBe(false);
  });

  it('counts code points', () => {
    expect(codePointLength('a\u{1F600}')).toBe(2);
  });

  it('writes an attachment field without a label and reads it back (§4, D278)', () => {
    const attachment = {
      name: ' scan 01.pdf',
      size: 10_485_760,
      mediaType: 'application/pdf',
      blobId: new Uint8Array(32).fill(1),
      key: new Uint8Array(32).fill(2),
    };
    const item: Item = { ...login, fields: [{ type: 'attachment', value: attachment }] };
    const content = itemToCbor(item, false);
    const value = (content.get('fields') as CborMap[])[0]?.get('value');
    expect(value).toEqual(
      map([
        ['name', attachment.name],
        ['size', attachment.size],
        ['mediaType', attachment.mediaType],
        ['blobId', attachment.blobId],
        ['key', attachment.key],
      ]),
    );
    expect(readItem(content, false)).toEqual({ readOnly: false, item });
    const invalid = {
      ...item,
      fields: [{ type: 'attachment', value: { ...attachment, size: 0 } }],
    };
    expect(() => itemToCbor(invalid as Item, false)).toThrow(ContentInvalidError);
  });

  it('writes `match` on a url field and reads it back, refusing it elsewhere (§4, D283)', () => {
    const url: Item = {
      ...login,
      fields: [{ type: 'url', role: 'url', value: 'https://example.com', match: 'domain' }],
    };
    const content = itemToCbor(url, false);
    expect((content.get('fields') as CborMap[])[0]?.get('match')).toBe('domain');
    expect(readItem(content, false)).toEqual({ readOnly: false, item: url });
    const text = { ...login, fields: [{ type: 'text', label: 'x', value: 'y', match: 'domain' }] };
    expect(() => itemToCbor(text as Item, false)).toThrow(ContentInvalidError);
  });
});

describe('passkey fields (§4, D288)', () => {
  const hex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));
  const eddsa = hex('302e020100300506032b657004220420' + '9d'.repeat(32));
  const es256 = hex(
    '308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b0201010420' +
      '01'.repeat(32) +
      'a14403420004' +
      '02'.repeat(64),
  );
  const passkey = {
    privateKey: eddsa,
    credentialId: new Uint8Array(16).fill(3),
    rpId: 'example.com',
    userHandle: new Uint8Array(64).fill(4),
    userName: 'alice@example.com',
    createdAt: 1_760_000_000_000,
  };

  it('writes a passkey without a label and reads it back, in either layout', () => {
    for (const privateKey of [eddsa, es256]) {
      const item: Item = {
        ...login,
        fields: [{ type: 'passkey', value: { ...passkey, privateKey } }],
      };
      const content = itemToCbor(item, false);
      expect((content.get('fields') as CborMap[])[0]?.get('value')).toEqual(
        map([
          ['privateKey', privateKey],
          ['credentialId', passkey.credentialId],
          ['rpId', passkey.rpId],
          ['userHandle', passkey.userHandle],
          ['userName', passkey.userName],
          ['createdAt', passkey.createdAt],
        ]),
      );
      expect(readItem(content, false)).toEqual({ readOnly: false, item });
    }
  });

  it('writes one without a userName, with a label', () => {
    const { privateKey, credentialId, rpId, userHandle, createdAt } = passkey;
    const value = { privateKey, credentialId, rpId, userHandle, createdAt };
    const item: Item = { ...login, fields: [{ type: 'passkey', label: 'Work', value }] };
    expect(readItem(itemToCbor(item, false), false)).toEqual({ readOnly: false, item });
  });

  it.each([
    ['a malformed PKCS#8 layout (CRYPTO-INV-027)', { privateKey: eddsa.subarray(0, 47) }],
    ['an empty credentialId', { credentialId: new Uint8Array(0) }],
    ['a credentialId of 1,024 bytes', { credentialId: new Uint8Array(1024) }],
    ['a userHandle of 65 bytes', { userHandle: new Uint8Array(65) }],
    ['an rpId of 254 code points', { rpId: 'a'.repeat(254) }],
    ['a multi-line userName', { userName: 'a\nb' }],
    ['an empty userName', { userName: '' }],
  ])('refuses to write %s', (_name, over) => {
    const item = { ...login, fields: [{ type: 'passkey', value: { ...passkey, ...over } }] };
    expect(() => itemToCbor(item as Item, false)).toThrow(ContentInvalidError);
  });

  it("stores the site's user.name on one line, cut to 255 code points, or not at all", () => {
    expect(passkeyUserName('alice\r\nsmith')).toBe('alice  smith');
    expect(passkeyUserName('\u{1F600}'.repeat(300))).toBe('\u{1F600}'.repeat(255));
    expect(passkeyUserName('')).toBeUndefined();
  });
});

describe('cited blobs (attachments.md §5)', () => {
  const id = (byte: number) => new Uint8Array(32).fill(byte);
  const attachment = (value: CborValue): CborMap =>
    new Map<string, CborValue>([
      ['type', 'attachment'],
      ['value', value],
    ]);

  it('reads every attachment field’s 32-byte blobId, whether or not the item validates', () => {
    const item: CborMap = new Map<string, CborValue>([
      ['templateId', 'login'],
      ['unknown', 'from a newer app'],
      [
        'fields',
        [
          attachment(new Map([['blobId', id(1)]])),
          new Map<string, CborValue>([
            ['type', 'secret'],
            ['value', new Map([['blobId', id(2)]])],
          ]),
          attachment(
            new Map<string, CborValue>([
              ['blobId', id(3)],
              ['size', 0],
            ]),
          ),
          attachment(new Map([['blobId', new Uint8Array(31)]])),
          attachment(new Map([['blobId', 'not bytes']])),
          attachment(id(4)),
          attachment(new Map()),
          'not a field',
        ],
      ],
    ]);
    expect(citedBlobIds(item)).toEqual([id(1), id(3)]);
  });

  it('cites nothing from a purged tombstone or content that is not an item', () => {
    expect(citedBlobIds(null)).toEqual([]);
    expect(citedBlobIds(undefined)).toEqual([]);
    expect(citedBlobIds('item')).toEqual([]);
    expect(citedBlobIds(new Map([['fields', 'none']]))).toEqual([]);
  });
});

describe('attachment input (attachments.md §3)', () => {
  it('keeps a name of up to 255 code points, line breaks replaced by spaces', () => {
    expect(attachmentName('scan.pdf')).toBe('scan.pdf');
    expect(attachmentName('a\r\nb\nc.txt')).toBe('a  b c.txt');
    expect(attachmentName(' ')).toBe(' ');
    expect(attachmentName('\u{1F4C4}'.repeat(255))).toBe('\u{1F4C4}'.repeat(255));
  });

  it('names an empty file name `attachment`', () => {
    expect(attachmentName('')).toBe('attachment');
  });

  it('cuts a longer name to 255 code points, keeping an extension of 1 to 16', () => {
    const cut = attachmentName(`${'\u{1F4C4}'.repeat(300)}.pdf`);
    expect(codePointLength(cut)).toBe(255);
    expect(cut).toBe(`${'\u{1F4C4}'.repeat(251)}.pdf`);
    const sixteen = `.${'e'.repeat(16)}`;
    expect(attachmentName(`${'n'.repeat(300)}${sixteen}`)).toBe(`${'n'.repeat(238)}${sixteen}`);
    // An extension of 17, an empty one or none: a plain cut.
    expect(attachmentName(`${'n'.repeat(300)}.${'e'.repeat(17)}`)).toBe('n'.repeat(255));
    expect(attachmentName(`${'n'.repeat(300)}.`)).toBe('n'.repeat(255));
    expect(attachmentName('n'.repeat(300))).toBe('n'.repeat(255));
    // The extension is after the last dot.
    expect(attachmentName(`${'n'.repeat(300)}.tar.gz`)).toBe(`${'n'.repeat(252)}.gz`);
  });

  it('keeps a media type of 1 to 255 characters U+0021 to U+007E, else application/octet-stream', () => {
    const octet = 'application/octet-stream';
    expect(attachmentMediaType('application/pdf')).toBe('application/pdf');
    expect(attachmentMediaType('x'.repeat(255))).toBe('x'.repeat(255));
    expect(attachmentMediaType('')).toBe(octet);
    expect(attachmentMediaType('x'.repeat(256))).toBe(octet);
    expect(attachmentMediaType('text/plain; charset=utf-8')).toBe(octet);
    expect(attachmentMediaType('text/plaîn')).toBe(octet);
    expect(attachmentMediaType('text/plain\u007f')).toBe(octet);
  });
});

describe('item reads beyond the vectors', () => {
  const base = itemToCbor(login, false);
  const withField = (field: CborMap) => new Map([...base, ['fields', [field]]]);

  it.each([
    ['a non-map item', 'item', 6],
    ['a non-text key', new Map<CborValue, CborValue>([...base, [1, 'x']]), 6],
    ['a templateId that is not text', new Map([...base, ['templateId', 3]]), 5],
    ['a bigint templateVersion', new Map([...base, ['templateVersion', 2n ** 60n]]), 5],
    ['fields that are not an array', new Map([...base, ['fields', 'x']]), 6],
    ['a field that is not a map', new Map([...base, ['fields', ['x']]]), 6],
    [
      'a field type that is not text',
      withField(
        map([
          ['type', 1],
          ['label', 'x'],
          ['value', 'v'],
        ]),
      ),
      6,
    ],
    [
      'a role that is not text',
      withField(
        map([
          ['type', 'text'],
          ['role', 1],
          ['value', 'v'],
        ]),
      ),
      6,
    ],
    [
      'a TOTP value that is not a map',
      withField(
        map([
          ['type', 'totp'],
          ['label', 'x'],
          ['value', 'v'],
        ]),
      ),
      6,
    ],
    [
      'a TOTP digits as text',
      withField(
        map([
          ['type', 'totp'],
          ['label', 'x'],
          [
            'value',
            map([
              ['secret', 'JBSWY3DP'],
              ['algorithm', 'SHA1'],
              ['digits', '6'],
              ['period', 30],
            ]),
          ],
        ]),
      ),
      6,
    ],
    [
      'a TOTP issuer that is not text',
      withField(
        map([
          ['type', 'totp'],
          ['label', 'x'],
          [
            'value',
            map([
              ['secret', 'JBSWY3DP'],
              ['algorithm', 'SHA1'],
              ['digits', 6],
              ['period', 30],
              ['issuer', 1],
            ]),
          ],
        ]),
      ),
      6,
    ],
    [
      'a TOTP accountName that is not text',
      withField(
        map([
          ['type', 'totp'],
          ['label', 'x'],
          [
            'value',
            map([
              ['secret', 'JBSWY3DP'],
              ['algorithm', 'SHA1'],
              ['digits', 6],
              ['period', 30],
              ['accountName', 1],
            ]),
          ],
        ]),
      ),
      6,
    ],
    [
      'a seed phrase that is not text',
      withField(
        map([
          ['type', 'seed-phrase'],
          ['label', 'x'],
          ['value', 1],
        ]),
      ),
      6,
    ],
    [
      'a date that is not text',
      withField(
        map([
          ['type', 'date'],
          ['label', 'x'],
          ['value', 1],
        ]),
      ),
      6,
    ],
    [
      'a long text that is empty',
      withField(
        map([
          ['type', 'long-text'],
          ['label', 'x'],
          ['value', ''],
        ]),
      ),
      6,
    ],
    ['a tag that is not text', new Map([...base, ['tags', [1]]]), 6],
  ] as [string, CborValue, number][])('makes %s read-only', (_name, content, rule) => {
    expect(readItem(content, false)).toEqual({ readOnly: true, rule });
  });

  it('checks calendar dates', () => {
    expect(isValidDate('2000-02-29', false)).toBe(true);
    expect(isValidDate('1900-02-29', false)).toBe(false);
    expect(isValidDate('2024-04-31', false)).toBe(false);
    expect(isValidDate('2024-04-00', false)).toBe(false);
    expect(isValidDate('9999-12-31', false)).toBe(true);
    expect(isValidDate('2024-04', true)).toBe(true);
    expect(isValidDate('2024-04-01', true)).toBe(false);
    expect(isValidDate('2024-4-01', false)).toBe(false);
  });
});

describe('Folder and Device writes (D59)', () => {
  it('builds a new folder and refuses an invalid one', () => {
    expect(encodeCbor(folderToCbor({ name: 'F', parentId: ID }, false))).toEqual(
      encodeCbor(
        map([
          ['name', 'F'],
          ['parentId', ID],
        ]),
      ),
    );
    expect(() => folderToCbor({ name: ' F' }, false)).toThrow(ContentInvalidError);
    expect(() => folderToCbor({ name: 'F' }, true)).toThrow(ContentInvalidError);
  });

  it('keeps unknown keys of the previous content through a rename', () => {
    const previous = map([
      ['name', 'Old'],
      ['color', 'blue'],
    ]);
    const renamed = folderToCbor({ name: 'New' }, false, previous);
    expect(renamed.get('color')).toBe('blue');
    expect(renamed.get('name')).toBe('New');
  });

  it('builds a device, keeps unknown keys, and refuses an invalid one', () => {
    const device = {
      publicKey: new Uint8Array(32),
      displayName: 'Phone',
      retired: false,
      registeredAt: 1,
    };
    const previous = map([['platform', 'web']]);
    expect(deviceToCbor(device, previous).get('platform')).toBe('web');
    expect(readDevice(deviceToCbor(device)).value).toEqual(device);
    expect(() => deviceToCbor({ ...device, displayName: '' })).toThrow(ContentInvalidError);
    expect(() => readDevice('device')).toThrow(ContentInvalidError);
  });
});

describe('Local Config reads beyond the vectors', () => {
  const sealed = (c: number) =>
    map([
      ['n', new Uint8Array(24)],
      ['c', new Uint8Array(c)],
    ]);
  const cleartext = map([
    ['localConfigFormatVersion', 1],
    ['vaultId', ID],
    ['localConfigId', ID],
    [
      'kek',
      map([
        ['salt', new Uint8Array(16)],
        ['opslimit', 2],
        ['memlimit', 67108864],
        ['mkWrap', sealed(48)],
      ]),
    ],
    ['encrypted', sealed(16)],
  ]);

  it('returns the optional PRF state and replaced vaultId', () => {
    const lc = readLocalConfig(
      new Map([
        ...cleartext,
        [
          'prf',
          map([
            ['credentialId', new Uint8Array(1)],
            ['prfInput', new Uint8Array(32)],
            ['mkWrap', sealed(48)],
          ]),
        ],
        ['replacesVaultId', ID],
      ]),
    );
    expect(lc.prf?.credentialId).toHaveLength(1);
    expect(lc.replacesVaultId).toEqual(ID);
    expect(lc.kek.opslimit).toBe(2);
  });

  it.each([
    ['a non-map', 'x'],
    ['an empty encrypted ciphertext', new Map([...cleartext, ['encrypted', sealed(15)]])],
    [
      'an empty credentialId',
      new Map([
        ...cleartext,
        [
          'prf',
          map([
            ['credentialId', new Uint8Array(0)],
            ['prfInput', new Uint8Array(32)],
            ['mkWrap', sealed(48)],
          ]),
        ],
      ]),
    ],
    ['a 15-byte replacesVaultId', new Map([...cleartext, ['replacesVaultId', new Uint8Array(15)]])],
    [
      'a text opslimit',
      new Map([
        ...cleartext,
        [
          'kek',
          map([
            ['salt', new Uint8Array(16)],
            ['opslimit', '2'],
            ['memlimit', 67108864],
            ['mkWrap', sealed(48)],
          ]),
        ],
      ]),
    ],
  ] as [string, CborValue][])('refuses %s as corrupt', (_name, value) => {
    expect(() => readLocalConfig(value)).toThrow(ContentInvalidError);
  });

  const part = map([
    [
      'deviceIdentity',
      map([
        ['publicKey', new Uint8Array(32)],
        ['privateKey', new Uint8Array(32)],
      ]),
    ],
    [
      'preferences',
      map([
        ['autoLockMinutes', 5],
        ['hiddenLockSeconds', 60],
        ['clipboardClearSeconds', 30],
      ]),
    ],
    ['hlc', [1, 0, ID]],
  ]);

  it('returns the later-phase keys of the encrypted part', () => {
    const read = readLocalConfigEncrypted(
      new Map([
        ...part,
        ['lastBackupAt', 5],
        ['lastPhraseId', ID],
        ['lastSyncByPeer', [[ID, 3]]],
        ['rejectedPeers', [ID]],
      ]),
    );
    expect(read).toMatchObject({
      lastBackupAt: 5,
      lastPhraseId: ID,
      lastSyncByPeer: [[ID, 3]],
      rejectedPeers: [ID],
    });
    expect(read.hlc).toEqual({ physicalMs: 1, counter: 0, deviceId: ID });
  });

  it.each([
    ['a text lastBackupAt', ['lastBackupAt', '5']],
    ['a short lastPhraseId', ['lastPhraseId', new Uint8Array(3)]],
    ['a malformed peer pair', ['lastSyncByPeer', [[ID]]]],
    ['lastSyncByPeer that is not an array', ['lastSyncByPeer', 1]],
    ['an hlc of two elements', ['hlc', [1, 0]]],
    ['an hlc with a text counter', ['hlc', [1, '0', ID]]],
  ] as [string, [string, CborValue]][])('refuses %s as corrupt', (_name, entry) => {
    expect(() => readLocalConfigEncrypted(new Map([...part, entry]))).toThrow(ContentInvalidError);
  });
});
