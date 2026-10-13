import { describe, expect, it } from 'vitest';

import { type Sealed, seal, wrapKey } from './aead';
import { type CborMap, type CborValue, decodeCbor, encodeCbor } from './cbor';
import { EncodingError, KeyWipedError } from './errors';
import { deviceId, recoveryEnvelopeRecordId, vaultKeyRecordId, versionId } from './ids';
import { Keyring, adoptKey, generateKey, keyBytes } from './keys';
import { type RecordHeader, recordAad } from './layout';
import { pad } from './pad';
import {
  type Envelope,
  ITEM_CAP,
  MAX_CIPHERTEXT_LENGTH,
  MAX_ENVELOPE_LENGTH,
  NewerRecordError,
  RECORD_CAP,
  RecordRejectedError,
  RecordType,
  type VerificationKeys,
  decodeEnvelope,
  encodeEnvelope,
  itemContentLength,
  sealPurgedTombstone,
  sealRecord,
  sealVaultKeyRecord,
  verifyRecord,
} from './record';
import { initCrypto, randomId } from './sodium';
import { fromHex, toHex, vectors } from './test-helpers';

// Test tables below build keys at collection time.
await initCrypto();

const r = vectors.records;
const VAULT_ID = fromHex('a0a1a2a3a4a5a6a7a8a9aaabacadaeaf');

function vectorKeys(keyring: Keyring): VerificationKeys {
  const vaultKey = adoptKey(keyring, fromHex(r.vaultKey));
  return {
    vaultId: VAULT_ID,
    vaultKey: (epoch) => (epoch === 1 ? vaultKey : undefined),
    vaultKeyWrapKey: adoptKey(keyring, fromHex(r.vaultKeyWrapKey)),
    versionIdKey: adoptKey(keyring, fromHex(vectors.ids.versionId.versionIdKey)),
  };
}

function rejectedAt(attempt: () => unknown): number | undefined {
  try {
    attempt();
  } catch (error) {
    if (error instanceof RecordRejectedError) return error.step;
    throw error;
  }
  return undefined;
}

function map(entries: [string, CborValue][]): CborMap {
  return new Map<CborValue, CborValue>(entries);
}

const keyring = new Keyring();
const keys = vectorKeys(keyring);
const vaultKey = keys.vaultKey(1);
if (!vaultKey) throw new Error('missing vault key');

function header(overrides: Partial<RecordHeader> = {}): RecordHeader {
  return {
    recordFormatVersion: 1,
    recordType: RecordType.item,
    recordId: randomId(),
    keyEpoch: 1,
    hlc: { physicalMs: 1_760_000_000_000, counter: 0, deviceId: new Uint8Array(16).fill(7) },
    deleted: false,
    ...overrides,
  };
}

const ITEM = map([
  ['templateId', 'login'],
  ['templateVersion', 1],
  ['title', 'Example'],
]);

describe('constants (crypto-spec.md §9.2, §9.4)', () => {
  it('match the generator', () => {
    expect(MAX_CIPHERTEXT_LENGTH).toBe(r.maxCiphertextLength);
    expect(ITEM_CAP).toBe(r.itemCap);
    expect(MAX_ENVELOPE_LENGTH).toBe(r.maxEnvelopeLength);
  });
});

describe('valid record vectors', () => {
  const valid = [
    'item',
    'purgedTombstone',
    'vaultKeyRecord',
    'recoveryEnvelope',
    'itemVersion',
    'itemWithFutureContent',
    'identityCollision',
  ] as const;

  it.each(valid)('%s verifies and its envelope re-encodes byte for byte', (name) => {
    const bytes = fromHex(r[name].envelope);
    const verified = verifyRecord(new Keyring(), bytes, keys);
    expect(toHex(encodeEnvelope(verified.envelope))).toBe(r[name].envelope);
  });

  it('item: content decodes to the vector map', () => {
    const { content } = verifyRecord(new Keyring(), fromHex(r.item.envelope), keys);
    expect(content).toEqual(ITEM);
    expect(toHex(encodeCbor(content ?? new Map()))).toBe(r.item.contentCbor);
  });

  it('purged tombstone: no content, deleted header', () => {
    const verified = verifyRecord(new Keyring(), fromHex(r.purgedTombstone.envelope), keys);
    expect(verified.content).toBeNull();
    expect(verified.envelope.header.deleted).toBe(true);
    expect(verified.envelope.ct.c).toHaveLength(16);
  });

  it('Vault Key record: yields the Vault Key in the caller keyring', () => {
    const into = new Keyring();
    const verified = verifyRecord(into, fromHex(r.vaultKeyRecord.envelope), keys);
    expect(verified.vaultKey && toHex(keyBytes(verified.vaultKey))).toBe(r.vaultKey);
    expect(into.size).toBe(1);
  });

  it('Recovery Envelope: metadata decoded, mk left sealed', () => {
    const verified = verifyRecord(new Keyring(), fromHex(r.recoveryEnvelope.envelope), keys);
    expect(toHex(encodeCbor(verified.content ?? new Map()))).toBe(r.recoveryEnvelope.metadataCbor);
    expect(verified.envelope.mk?.c).toHaveLength(48);
  });

  it('Item Version and future content keep their exact encoding (D52)', () => {
    for (const name of ['itemVersion', 'itemWithFutureContent'] as const) {
      const { content } = verifyRecord(new Keyring(), fromHex(r[name].envelope), keys);
      expect(toHex(encodeCbor(content ?? new Map()))).toBe(r[name].contentCbor);
    }
  });

  it('identity collision: an Item with the Vault Key recordId is an Item (D158)', () => {
    const verified = verifyRecord(new Keyring(), fromHex(r.identityCollision.envelope), keys);
    expect(verified.envelope.header.recordType).toBe(RecordType.item);
    expect(toHex(verified.envelope.header.recordId)).toBe(r.identityCollision.recordId);
  });

  it('wipes the record keys it opened', () => {
    const into = new Keyring();
    verifyRecord(into, fromHex(r.item.envelope), keys);
    expect(into.size).toBe(0);
  });
});

describe('negative vectors (crypto-spec.md §9.5, CRYPTO-INV-012, CRYPTO-INV-016)', () => {
  it.each(vectors.negative.envelopes)('step $expectedStep: $case', ({ envelope, expectedStep }) => {
    expect(rejectedAt(() => verifyRecord(new Keyring(), fromHex(envelope), keys))).toBe(
      expectedStep,
    );
  });

  it('step 1: an envelope longer than the largest valid one, before decoding', () => {
    const tooLong = new Uint8Array(MAX_ENVELOPE_LENGTH + 1);
    expect(rejectedAt(() => verifyRecord(new Keyring(), tooLong, keys))).toBe(1);
  });

  it('step 5: ct.c longer than the padded record cap, before decryption', () => {
    const h = header();
    const filler: Sealed = { n: new Uint8Array(24), c: new Uint8Array(48) };
    const bytes = encodeEnvelope({
      header: h,
      wk: filler,
      ct: { n: new Uint8Array(24), c: new Uint8Array(MAX_CIPHERTEXT_LENGTH + 1) },
    });
    expect(rejectedAt(() => verifyRecord(new Keyring(), bytes, keys))).toBe(5);
  });

  it('step 3: an envelope map with a non-text key', () => {
    const m = decodeCbor(fromHex(r.item.envelope)) as CborMap;
    m.set(1, 1);
    expect(rejectedAt(() => verifyRecord(new Keyring(), encodeCbor(m), keys))).toBe(3);
  });

  it('a wiped key is a lock, not a rejection: KeyWipedError propagates (CRYPTO-INV-010)', () => {
    const locked = new Keyring();
    const lockedKeys = vectorKeys(locked);
    locked.wipeAll();
    expect(() => verifyRecord(new Keyring(), fromHex(r.item.envelope), lockedKeys)).toThrow(
      KeyWipedError,
    );
    expect(() =>
      verifyRecord(new Keyring(), fromHex(r.vaultKeyRecord.envelope), lockedKeys),
    ).toThrow(KeyWipedError);
  });

  it('a Vault Key record rejected at step 10 leaves no key in the keyring', () => {
    const into = new Keyring();
    const step10 = vectors.negative.envelopes.find((n) =>
      n.case.startsWith('Vault Key record whose recordId'),
    );
    expect(step10).toBeDefined();
    expect(rejectedAt(() => verifyRecord(into, fromHex(step10?.envelope ?? ''), keys))).toBe(10);
    expect(into.size).toBe(0);
  });
});

/** Seals content without the write-side cap checks, as a faulty peer could. */
function sealUnchecked(h: RecordHeader, plaintext: Uint8Array): Uint8Array {
  const aad = recordAad(h, VAULT_ID);
  const temp = new Keyring();
  const recordKey = generateKey(temp);
  if (!vaultKey) throw new Error('missing vault key');
  return encodeEnvelope({
    header: h,
    wk: wrapKey(vaultKey, aad, recordKey),
    ct: seal(recordKey, aad, plaintext),
  });
}

function itemOfLength(length: number): CborMap {
  const base = (n: number) =>
    itemContentLength(map([...ITEM, ['notes', 'x'.repeat(n)]] as [string, CborValue][]));
  const n = length - base(70_000) + 70_000;
  const item = map([...ITEM, ['notes', 'x'.repeat(n)]] as [string, CborValue][]);
  expect(itemContentLength(item)).toBe(length);
  return item;
}

describe('item cap (D139, D144)', () => {
  it('accepts an item exactly at the cap, and one at the cap with trashOperationId', () => {
    const atCap = itemOfLength(ITEM_CAP);
    const h = header();
    expect(
      rejectedAt(() => verifyRecord(new Keyring(), sealRecord(h, keys, vaultKey, atCap), keys)),
    ).toBeUndefined();
    const trashed = new Map(atCap).set('trashOperationId', randomId());
    const th = header({ deleted: true });
    expect(
      rejectedAt(() => verifyRecord(new Keyring(), sealRecord(th, keys, vaultKey, trashed), keys)),
    ).toBeUndefined();
  });

  it('step 9: a received item one byte above the cap', () => {
    const bytes = sealUnchecked(header(), pad(encodeCbor(itemOfLength(ITEM_CAP + 1))));
    expect(rejectedAt(() => verifyRecord(new Keyring(), bytes, keys))).toBe(9);
  });

  it('step 9: a received Item Version whose item is above the cap', () => {
    const itemId = randomId();
    const h = header({ recordType: RecordType.itemVersion });
    const content = map([
      ['item', itemOfLength(ITEM_CAP + 1)],
      ['itemId', itemId],
    ]);
    const id = versionId(keys.versionIdKey, itemId, h.hlc);
    const bytes = sealUnchecked({ ...h, recordId: id }, pad(encodeCbor(content)));
    expect(rejectedAt(() => verifyRecord(new Keyring(), bytes, keys))).toBe(9);
  });

  it('step 9: an Item Version without an item map', () => {
    const itemId = randomId();
    const h = header({ recordType: RecordType.itemVersion });
    const bytes = sealUnchecked(
      { ...h, recordId: versionId(keys.versionIdKey, itemId, h.hlc) },
      pad(
        encodeCbor(
          map([
            ['item', 'not a map'],
            ['itemId', itemId],
          ]),
        ),
      ),
    );
    expect(rejectedAt(() => verifyRecord(new Keyring(), bytes, keys))).toBe(9);
  });

  it('refuses to write an item above the item cap or content above the record cap', () => {
    expect(() => sealRecord(header(), keys, vaultKey, itemOfLength(ITEM_CAP + 1))).toThrow(
      EncodingError,
    );
    const folder = map([['name', 'x'.repeat(RECORD_CAP)]]);
    expect(() =>
      sealRecord(header({ recordType: RecordType.folder }), keys, vaultKey, folder),
    ).toThrow(EncodingError);
  });
});

describe('derived recordId (step 10, D66)', () => {
  const publicKey = new Uint8Array(32).fill(3);

  it('a Device record verifies only under the deviceId of its public key', () => {
    const content = map([
      ['publicKey', publicKey],
      ['displayName', 'Phone'],
    ]);
    const good = header({ recordType: RecordType.device, recordId: deviceId(publicKey) });
    expect(
      verifyRecord(new Keyring(), sealRecord(good, keys, vaultKey, content), keys).content,
    ).toEqual(content);
    const forged = sealUnchecked({ ...good, recordId: randomId() }, pad(encodeCbor(content)));
    expect(rejectedAt(() => verifyRecord(new Keyring(), forged, keys))).toBe(10);
    const noKey = sealUnchecked(good, pad(encodeCbor(map([['displayName', 'Phone']]))));
    expect(rejectedAt(() => verifyRecord(new Keyring(), noKey, keys))).toBe(10);
  });

  it('an Item Version without a 16-byte itemId', () => {
    const h = header({ recordType: RecordType.itemVersion });
    const bytes = sealUnchecked(h, pad(encodeCbor(map([['item', ITEM]]))));
    expect(rejectedAt(() => verifyRecord(new Keyring(), bytes, keys))).toBe(10);
  });

  it('refuses to write a recordId that does not match its derivation', () => {
    const content = map([['publicKey', publicKey]]);
    expect(() =>
      sealRecord(
        header({ recordType: RecordType.device, recordId: randomId() }),
        keys,
        vaultKey,
        content,
      ),
    ).toThrow(EncodingError);
    expect(() =>
      sealRecord(
        header({ recordType: RecordType.itemVersion }),
        keys,
        vaultKey,
        map([
          ['itemId', randomId()],
          ['item', ITEM],
        ]),
      ),
    ).toThrow(EncodingError);
    expect(() =>
      sealRecord(
        header({ recordType: RecordType.itemVersion }),
        keys,
        vaultKey,
        map([['item', ITEM]]),
      ),
    ).toThrow(EncodingError);
  });
});

describe('header tampering (Gate A, D21, CRYPTO-INV-004)', () => {
  const h = header();
  const sealed = sealRecord(h, keys, vaultKey, ITEM);
  const envelope = decodeEnvelope(sealed);

  function reencoded(change: Partial<RecordHeader>, from: Envelope = envelope): Uint8Array {
    return encodeEnvelope({ ...from, header: { ...from.header, ...change } });
  }

  it.each<[string, Partial<RecordHeader>]>([
    ['an edited hlc counter', { hlc: { ...h.hlc, counter: 1 } }],
    [
      'an edited hlc physical time',
      { hlc: { ...h.hlc, physicalMs: h.hlc.physicalMs + 86_400_000 } },
    ],
    ['an edited hlc deviceId', { hlc: { ...h.hlc, deviceId: new Uint8Array(16) } }],
    ['a forged tombstone (deleted set on a live record)', { deleted: true }],
    ['another recordId', { recordId: randomId() }],
    ['another recordType', { recordType: RecordType.folder }],
  ])('rejects %s at step 7', (_name, change) => {
    expect(rejectedAt(() => verifyRecord(new Keyring(), reencoded(change), keys))).toBe(7);
  });

  it('rejects a wrong keyEpoch: its Vault Key is not held', () => {
    expect(rejectedAt(() => verifyRecord(new Keyring(), reencoded({ keyEpoch: 2 }), keys))).toBe(7);
  });

  it('rejects an unknown recordFormatVersion at step 3 (D32)', () => {
    const map2 = decodeCbor(sealed) as CborMap;
    map2.set('v', 2);
    expect(rejectedAt(() => verifyRecord(new Keyring(), encodeCbor(map2), keys))).toBe(3);
  });

  it('rejects older ciphertext replayed under a newer hlc', () => {
    const older = decodeEnvelope(
      sealRecord(header({ recordId: h.recordId }), keys, vaultKey, ITEM),
    );
    const newer = header({ recordId: h.recordId, hlc: { ...h.hlc, counter: 5 } });
    const replay = encodeEnvelope({ ...older, header: newer });
    expect(rejectedAt(() => verifyRecord(new Keyring(), replay, keys))).toBe(7);
  });

  it("rejects one item's ciphertext substituted into another's record", () => {
    const other = decodeEnvelope(sealRecord(header(), keys, vaultKey, map([['title', 'Other']])));
    const swapped = encodeEnvelope({ ...envelope, ct: other.ct });
    const swappedBoth = encodeEnvelope({ ...envelope, wk: other.wk ?? envelope.ct, ct: other.ct });
    expect(rejectedAt(() => verifyRecord(new Keyring(), swapped, keys))).toBe(7);
    expect(rejectedAt(() => verifyRecord(new Keyring(), swappedBoth, keys))).toBe(7);
  });

  it('rejects a record of another vault', () => {
    expect(
      rejectedAt(() => verifyRecord(new Keyring(), sealed, { ...keys, vaultId: randomId() })),
    ).toBe(7);
  });
});

describe('writing records', () => {
  it('seals a new record key on every write', () => {
    const h = header();
    const a = decodeEnvelope(sealRecord(h, keys, vaultKey, ITEM));
    const b = decodeEnvelope(sealRecord(h, keys, vaultKey, ITEM));
    expect(toHex(a.wk?.c ?? new Uint8Array())).not.toBe(toHex(b.wk?.c ?? new Uint8Array()));
    expect(a.ct.c.length - 16).toBe(256);
  });

  it('seals and verifies a purged tombstone', () => {
    const h = header({ deleted: true });
    const verified = verifyRecord(new Keyring(), sealPurgedTombstone(h, VAULT_ID, vaultKey), keys);
    expect(verified.content).toBeNull();
    expect(() => sealPurgedTombstone(header(), VAULT_ID, vaultKey)).toThrow(EncodingError);
    expect(() =>
      sealPurgedTombstone(
        header({ recordType: RecordType.device, deleted: true }),
        VAULT_ID,
        vaultKey,
      ),
    ).toThrow(EncodingError);
  });

  it('seals and verifies a Vault Key record', () => {
    const h = header({ recordType: RecordType.vaultKey, recordId: vaultKeyRecordId(1) });
    const into = new Keyring();
    const verified = verifyRecord(
      into,
      sealVaultKeyRecord(h, VAULT_ID, keys.vaultKeyWrapKey, vaultKey),
      keys,
    );
    expect(verified.vaultKey && keyBytes(verified.vaultKey)).toEqual(keyBytes(vaultKey));
    expect(() =>
      sealVaultKeyRecord(
        { ...h, recordId: vaultKeyRecordId(2) },
        VAULT_ID,
        keys.vaultKeyWrapKey,
        vaultKey,
      ),
    ).toThrow(EncodingError);
  });

  it.each<[string, Partial<RecordHeader>]>([
    ['an unsupported recordFormatVersion', { recordFormatVersion: 2 }],
    ['a Vault Key through sealRecord', { recordType: RecordType.vaultKey }],
    ['a Recovery Envelope through sealRecord', { recordType: RecordType.recoveryEnvelope }],
    ['a deleted Device', { recordType: RecordType.device, deleted: true }],
  ])('refuses %s', (_name, change) => {
    expect(() => sealRecord(header(change), keys, vaultKey, ITEM)).toThrow(EncodingError);
  });

  it('refuses an envelope whose parts do not match its type', () => {
    const sealed: Sealed = { n: new Uint8Array(24), c: new Uint8Array(48) };
    expect(() => encodeEnvelope({ header: header(), ct: sealed })).toThrow(EncodingError);
    expect(() => encodeEnvelope({ header: header(), wk: sealed, ct: sealed, mk: sealed })).toThrow(
      EncodingError,
    );
    expect(() => encodeEnvelope({ header: header({ recordType: 7 }), ct: sealed })).toThrow(
      EncodingError,
    );
  });
});

describe('encrypt and decrypt every record type (Gate A)', () => {
  const itemId = randomId();
  const publicKey = new Uint8Array(32).fill(3);
  const FOLDER = map([['name', 'Work']]);
  const TRASHED = map([...ITEM, ['trashOperationId', randomId()]] as [string, CborValue][]);
  const versionHeader = header({ recordType: RecordType.itemVersion });
  const VERSION = map([
    ['itemId', itemId],
    ['item', ITEM],
  ]);
  const DEVICE = map([
    ['publicKey', publicKey],
    ['displayName', 'Phone'],
  ]);

  /** Each record type as the session writes it; a Recovery Envelope has no writer before Phase 2. */
  const cases: [string, () => Uint8Array, CborMap | null][] = [
    ['an item', () => sealRecord(header(), keys, vaultKey, ITEM), ITEM],
    [
      'an item in the trash',
      () => sealRecord(header({ deleted: true }), keys, vaultKey, TRASHED),
      TRASHED,
    ],
    [
      'a purged item tombstone',
      () => sealPurgedTombstone(header({ deleted: true }), VAULT_ID, vaultKey),
      null,
    ],
    [
      'a folder',
      () => sealRecord(header({ recordType: RecordType.folder }), keys, vaultKey, FOLDER),
      FOLDER,
    ],
    [
      'a folder in the trash',
      () =>
        sealRecord(
          header({ recordType: RecordType.folder, deleted: true }),
          keys,
          vaultKey,
          FOLDER,
        ),
      FOLDER,
    ],
    [
      'a purged folder tombstone',
      () =>
        sealPurgedTombstone(
          header({ recordType: RecordType.folder, deleted: true }),
          VAULT_ID,
          vaultKey,
        ),
      null,
    ],
    [
      'an Item Version',
      () =>
        sealRecord(
          { ...versionHeader, recordId: versionId(keys.versionIdKey, itemId, versionHeader.hlc) },
          keys,
          vaultKey,
          VERSION,
        ),
      VERSION,
    ],
    [
      'a Device record',
      () =>
        sealRecord(
          header({ recordType: RecordType.device, recordId: deviceId(publicKey) }),
          keys,
          vaultKey,
          DEVICE,
        ),
      DEVICE,
    ],
  ];

  it.each(cases)('%s opens to its content, header unchanged', (_name, sealed, content) => {
    const bytes = sealed();
    const verified = verifyRecord(new Keyring(), bytes, keys);
    expect(verified.content).toEqual(content);
    expect(verified.envelope).toEqual(decodeEnvelope(bytes));
  });

  it.each(cases)('%s opens under no other Vault Key or vault', (_name, sealed) => {
    const bytes = sealed();
    const other = generateKey(new Keyring());
    const wrongKey = { ...keys, vaultKey: () => other };
    expect(rejectedAt(() => verifyRecord(new Keyring(), bytes, wrongKey))).toBe(7);
    expect(
      rejectedAt(() => verifyRecord(new Keyring(), bytes, { ...keys, vaultId: randomId() })),
    ).toBe(7);
  });

  it('a Vault Key record opens to its key, under no other wrap key or vault', () => {
    const h = header({ recordType: RecordType.vaultKey, recordId: vaultKeyRecordId(1) });
    const bytes = sealVaultKeyRecord(h, VAULT_ID, keys.vaultKeyWrapKey, vaultKey);
    const into = new Keyring();
    const verified = verifyRecord(into, bytes, keys);
    expect(verified.vaultKey && keyBytes(verified.vaultKey)).toEqual(keyBytes(vaultKey));
    expect(verified.envelope.header).toEqual(h);
    const other = generateKey(new Keyring());
    expect(
      rejectedAt(() => verifyRecord(new Keyring(), bytes, { ...keys, vaultKeyWrapKey: other })),
    ).toBe(7);
    expect(
      rejectedAt(() => verifyRecord(new Keyring(), bytes, { ...keys, vaultId: randomId() })),
    ).toBe(7);
  });

  it('a Recovery Envelope opens to its metadata with mk left sealed, under no other key or vault', () => {
    const h = header({
      recordType: RecordType.recoveryEnvelope,
      recordId: recoveryEnvelopeRecordId(VAULT_ID),
    });
    const metadata = map([
      ['keyslotPublicKey', new Uint8Array(32).fill(1)],
      ['phraseId', randomId()],
      ['phraseCreatedAt', 1_760_000_000_000],
    ]);
    const aad = recordAad(h, VAULT_ID);
    const temp = new Keyring();
    const recordKey = generateKey(temp);
    const mk = wrapKey(generateKey(temp), aad, generateKey(temp));
    const bytes = encodeEnvelope({
      header: h,
      wk: wrapKey(vaultKey, aad, recordKey),
      ct: seal(recordKey, aad, pad(encodeCbor(metadata))),
      mk,
    });
    temp.wipeAll();
    const verified = verifyRecord(new Keyring(), bytes, keys);
    expect(verified.content).toEqual(metadata);
    expect(verified.envelope.mk).toEqual(mk);
    const other = generateKey(new Keyring());
    expect(
      rejectedAt(() => verifyRecord(new Keyring(), bytes, { ...keys, vaultKey: () => other })),
    ).toBe(7);
    expect(
      rejectedAt(() => verifyRecord(new Keyring(), bytes, { ...keys, vaultId: randomId() })),
    ).toBe(7);
  });
});

describe('records of a newer app (crypto-spec.md §9.5 step 3, D61, D81)', () => {
  function edited(entries: [string, CborValue][]): Uint8Array {
    const m = decodeCbor(fromHex(r.item.envelope)) as CborMap;
    for (const [k, v] of entries) m.set(k, v);
    return encodeCbor(m);
  }

  function rejection(bytes: Uint8Array): unknown {
    try {
      decodeEnvelope(bytes);
    } catch (error) {
      return error;
    }
    return undefined;
  }

  it.each([
    ['recordFormatVersion 2', [['v', 2]]],
    ['recordFormatVersion 2^32', [['v', 2 ** 32]]],
    ['recordType 7', [['t', 7]]],
    ['recordType 0', [['t', 0]]],
    [
      'recordFormatVersion 2 with a shape v1 does not know',
      [
        ['v', 2],
        ['x', 1],
      ],
    ],
  ] as [string, [string, CborValue][]][])('is a newer record: %s', (_, entries) => {
    const error = rejection(edited(entries));
    expect(error).toBeInstanceOf(NewerRecordError);
    expect((error as NewerRecordError).step).toBe(3);
    expect(rejectedAt(() => verifyRecord(new Keyring(), edited(entries), keys))).toBe(3);
  });

  it.each([
    ['recordFormatVersion 0', [['v', 0]]],
    ['recordFormatVersion as text', [['v', '2']]],
    ['recordFormatVersion negative', [['v', -1]]],
    ['recordType as text', [['t', '1']]],
    [
      'recordType 7 with recordFormatVersion 0',
      [
        ['v', 0],
        ['t', 7],
      ],
    ],
    ['an unknown envelope key', [['x', 1]]],
  ] as [string, [string, CborValue][]][])('is not a newer record: %s', (_, entries) => {
    const error = rejection(edited(entries));
    expect(error).toBeInstanceOf(RecordRejectedError);
    expect(error).not.toBeInstanceOf(NewerRecordError);
  });

  it('is not a newer record when the bytes are no CBOR map at all', () => {
    expect(rejection(new Uint8Array([0xff]))).not.toBeInstanceOf(NewerRecordError);
    expect(rejection(encodeCbor([1, 2]))).not.toBeInstanceOf(NewerRecordError);
  });
});
