// The vault session written through the IndexedDB store (D82, D163): what reaches IndexedDB is
// sealed records and Local Config only, and a fresh session unlocks from it.

import {
  type CborMap,
  type CborValue,
  Keyring,
  MEMLIMIT,
  LocalPurpose,
  RecordType,
  type SymmetricKey,
  decodeCbor,
  decodeEnvelope,
  deriveMasterSubkeys,
  derivePrfKek,
  deriveRecoveryKeys,
  generateKey,
  generatePrfInput,
  generateRecoveryPhrase,
  initCrypto,
  localAad,
  open,
  parseRecoveryPhrase,
  recordAad,
  unpad,
  unwrapKey,
  wrapKey,
} from '@blindvault/crypto';
import { VaultDatabase, databaseName } from '@blindvault/storage';
import {
  type ItemInput,
  type RecordStore,
  UnlockRejectedError,
  VaultSession,
  parseLocalConfig,
} from '@blindvault/vault';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

beforeAll(initCrypto);

const T0 = 1_760_000_000_000;
const now = () => T0;

/** A reproducible KEK: a PRF KEK of a fixed output, standing in for Argon2id here. */
function kek(keyring: Keyring, seed = 1): SymmetricKey {
  const authenticatorData = new Uint8Array(37);
  authenticatorData[32] = 0x05;
  return derivePrfKek(keyring, { authenticatorData, prfOutput: new Uint8Array(32).fill(seed) });
}

const SECRETS = [
  'Bank of Somewhere',
  'hunter2-very-secret',
  'PIN is in the drawer',
  'finance',
  'alice',
  'Taxes 2026',
  'Chrome on macOS',
];

function login(): ItemInput {
  return {
    templateId: 'login',
    templateVersion: 1,
    title: 'Bank of Somewhere',
    fields: [
      { type: 'text', role: 'username', value: 'alice' },
      { type: 'secret', role: 'password', value: 'hunter2-very-secret' },
    ],
    tags: ['finance'],
    notes: 'PIN is in the drawer',
  };
}

/**
 * What a stored phrase would contain: the whole phrase and every pair of neighbouring words, with
 * or without a space. Single words are not enough: BIP39 words such as "salt" or "local" also
 * appear in Local Config's own keys.
 */
function phraseTraces(words: string): string[] {
  const list = words.split(' ');
  const out = [words];
  for (let i = 0; i + 1 < list.length; i++) {
    out.push(`${list[i] ?? ''} ${list[i + 1] ?? ''}`, `${list[i] ?? ''}${list[i + 1] ?? ''}`);
  }
  return out;
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** Every byte value IndexedDB holds for the database `name`, read without this app's code. */
async function dump(factory: IDBFactory, name: string): Promise<Uint8Array[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name);
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(new Error('open failed'));
    };
  });
  const tx = db.transaction([...db.objectStoreNames]);
  const requests = [...db.objectStoreNames].map((s) => tx.objectStore(s).getAll());
  await new Promise((resolve) => (tx.oncomplete = resolve));
  db.close();
  return requests
    .flatMap((r) => r.result as unknown[])
    .map((v) => {
      if (!(v instanceof Uint8Array)) throw new Error('a stored value is not bytes');
      return v;
    });
}

function keysOf(value: CborValue | undefined): string[] {
  if (!(value instanceof Map)) throw new Error('not a map');
  return [...value.keys()].map(String).sort();
}

const sessions: VaultSession[] = [];
const databases: VaultDatabase[] = [];

afterEach(() => {
  for (const s of sessions.splice(0)) s.lock();
  for (const d of databases.splice(0)) d.close();
});

async function created(factory: IDBFactory) {
  // The vault ID is known once the session exists; the database is opened for it first here
  // through a throwaway ID, so build the session over a store that opens lazily.
  let db: VaultDatabase | undefined;
  let vaultId: Uint8Array | undefined;
  const store: RecordStore = {
    records: () => Promise.resolve([]),
    commit: async (commit) => {
      if (!db) {
        vaultId = parseLocalConfig(commit.localConfig).vaultId;
        db = await VaultDatabase.open(vaultId, factory);
        databases.push(db);
      }
      await db.commit(commit);
    },
  };
  const keyring = new Keyring();
  const phrase = generateRecoveryPhrase(keyring);
  const session = await VaultSession.create({
    store,
    keyring,
    kek: kek(keyring),
    recoveryEntropy: phrase.entropy,
    salt: new Uint8Array(16).fill(7),
    kdfParams: { opslimit: 2, memlimit: MEMLIMIT },
    displayName: 'Chrome on macOS',
    now,
  });
  sessions.push(session);
  if (!vaultId) throw new Error('nothing committed');
  return { session, vaultId, words: phrase.words };
}

/**
 * The bytes of `key`, through the public API only: wrapped under a fresh key and opened again.
 * A test needs them to look for the key; the package never hands them out.
 */
function bytesOf(keyring: Keyring, key: SymmetricKey): Uint8Array {
  const probe = generateKey(keyring);
  const aad = new TextEncoder().encode('test probe');
  return open(probe, aad, wrapKey(probe, aad, key));
}

/**
 * Every key of the vault in `vaultId`, recovered from what IndexedDB holds and the Device KEK of
 * `seed`: the Master Key, its four subkeys, each Vault Key, each Record Key and the device private
 * key.
 */
async function vaultKeys(
  factory: IDBFactory,
  vaultId: Uint8Array,
  seed: number,
): Promise<Map<string, Uint8Array>> {
  const db = await VaultDatabase.open(vaultId, factory);
  databases.push(db);
  const config = parseLocalConfig((await db.localConfig()) ?? new Uint8Array(0));
  const keyring = new Keyring();
  const keys = new Map<string, Uint8Array>();
  const mkAad = localAad(LocalPurpose.mkWrapDeviceKek, vaultId, config.localConfigId);
  keys.set('master key', open(kek(keyring, seed), mkAad, config.kek.mkWrap));
  const masterKey = unwrapKey(keyring, kek(keyring, seed), mkAad, config.kek.mkWrap);
  const subkeys = deriveMasterSubkeys(keyring, masterKey);
  for (const [name, key] of Object.entries(subkeys) as [string, SymmetricKey][]) {
    keys.set(`subkey ${name}`, bytesOf(keyring, key));
  }

  const part = open(
    subkeys.localConfig,
    localAad(LocalPurpose.localConfig, vaultId, config.localConfigId),
    config.encrypted,
  );
  const identity = (decodeCbor(unpad(part)) as CborMap).get('deviceIdentity') as CborMap;
  keys.set('device private key', identity.get('privateKey') as Uint8Array);

  const records = (await db.records()).map((r) => decodeEnvelope(r.envelope));
  const epochs = new Map<number, SymmetricKey>();
  for (const { header, ct } of records) {
    if (header.recordType !== RecordType.vaultKey) continue;
    const aad = recordAad(header, vaultId);
    keys.set(`vault key ${String(header.keyEpoch)}`, open(subkeys.vaultKeyWrap, aad, ct));
    epochs.set(header.keyEpoch, unwrapKey(keyring, subkeys.vaultKeyWrap, aad, ct));
  }
  records.forEach(({ header, wk }, i) => {
    const vaultKey = epochs.get(header.keyEpoch);
    if (!wk || !vaultKey) return;
    keys.set(`record key ${String(i)}`, open(vaultKey, recordAad(header, vaultId), wk));
  });
  keyring.wipeAll();
  return keys;
}

async function unlocked(factory: IDBFactory, vaultId: Uint8Array, seed = 1) {
  const db = await VaultDatabase.open(vaultId, factory);
  databases.push(db);
  const bytes = await db.localConfig();
  if (!bytes) throw new Error('no Local Config');
  const store: RecordStore = db;
  const keyring = new Keyring();
  const session = await VaultSession.unlock({
    store,
    localConfig: parseLocalConfig(bytes),
    keyring,
    kek: kek(keyring, seed),
    method: 'password',
    now,
  });
  sessions.push(session);
  return session;
}

describe('vault session over IndexedDB (D82, D163)', () => {
  it('persists only sealed records and the allowed Local Config (CRYPTO-INV-001, 019)', async () => {
    const factory = new IDBFactory();
    const { session, vaultId } = await created(factory);
    const folderId = await session.createFolder('Taxes 2026');
    await session.createItem({ ...login(), folderId });
    session.lock();

    const values = await dump(factory, databaseName(vaultId));
    for (const text of SECRETS) {
      const needle = new TextEncoder().encode(text);
      expect(values.some((bytes) => contains(bytes, needle))).toBe(false);
    }

    const db = await VaultDatabase.open(vaultId, factory);
    databases.push(db);
    const config = decodeCbor((await db.localConfig()) ?? new Uint8Array(0)) as CborMap;
    expect(keysOf(config)).toEqual([
      'encrypted',
      'kek',
      'localConfigFormatVersion',
      'localConfigId',
      'vaultId',
    ]);
    expect(keysOf(config.get('kek'))).toEqual(['memlimit', 'mkWrap', 'opslimit', 'salt']);
    expect(keysOf(config.get('encrypted'))).toEqual(['c', 'n']);
  });

  it('unlocks a fresh session from IndexedDB, and refuses another KEK', async () => {
    const factory = new IDBFactory();
    const { session, vaultId } = await created(factory);
    const folderId = await session.createFolder('Taxes 2026');
    const itemId = await session.createItem({ ...login(), folderId });
    session.lock();
    for (const d of databases.splice(0)) d.close();

    await expect(unlocked(factory, vaultId, 2)).rejects.toThrow(UnlockRejectedError);
    const again = await unlocked(factory, vaultId);
    expect(again.item(itemId)?.item?.title).toBe('Bank of Somewhere');
    expect(again.folder(folderId)?.name).toBe('Taxes 2026');
    expect(again.corrupt()).toEqual([]);
    // A write after unlock lands in the same database.
    await again.renameFolder(folderId, 'Taxes 2027');
    again.lock();
    expect((await unlocked(factory, vaultId)).folder(folderId)?.name).toBe('Taxes 2027');
  });

  it('holds no key, no recovery secret and no plaintext after a full use, PRF wrap and password change included (CRYPTO-INV-001, 003, 006)', async () => {
    const factory = new IDBFactory();
    const { session, vaultId, words } = await created(factory);
    const folderId = await session.createFolder('Taxes 2026');
    const itemId = await session.createItem({ ...login(), folderId });
    // The old password stays in an Item Version, sealed.
    await session.updateItem(itemId, {
      ...login(),
      folderId,
      fields: [
        { type: 'text', role: 'username', value: 'alice' },
        { type: 'secret', role: 'password', value: 'correct-horse-rotated' },
      ],
    });
    const trashed = await session.createItem({ ...login(), title: 'Old forum account' });
    await session.trashItem(trashed);
    const keyring = new Keyring();
    await session.setPasskey({
      current: kek(keyring, 1),
      prfKek: kek(keyring, 3),
      credentialId: new Uint8Array([1, 2, 3, 4]),
      prfInput: generatePrfInput(),
    });
    await session.changePassword({
      current: kek(keyring, 1),
      next: kek(keyring, 2),
      salt: new Uint8Array(16).fill(8),
      kdfParams: { opslimit: 2, memlimit: MEMLIMIT },
    });
    const kekBytes = [1, 2, 3].map((seed) => bytesOf(keyring, kek(keyring, seed)));
    // The Recovery Phrase, its entropy and the envelope key it derives (§5.4).
    const entropy = parseRecoveryPhrase(keyring, words);
    const recovery = deriveRecoveryKeys(keyring, entropy);
    const recoveryBytes = [bytesOf(keyring, entropy), bytesOf(keyring, recovery.envelopeKey)];
    keyring.wipeAll();
    session.lock();

    const keys = await vaultKeys(factory, vaultId, 2);
    const recordKeys = [...keys.keys()].filter((name) => name.startsWith('record key'));
    // Recovery Envelope, Device record, folder, two items and the Item Version, each under its own
    // record key.
    expect(recordKeys.length).toBeGreaterThanOrEqual(6);
    const needles = [
      ...keys.values(),
      ...kekBytes,
      ...recoveryBytes,
      // Encrypted in the envelope's metadata, never in the clear.
      recovery.keyslotPublicKey,
      ...[...SECRETS, 'correct-horse-rotated', 'Old forum account', ...phraseTraces(words)].map(
        (t) => new TextEncoder().encode(t),
      ),
    ];
    for (const needle of needles) expect(needle.length).toBeGreaterThan(0);
    for (const k of [...keys.values(), ...kekBytes, ...recoveryBytes]) expect(k.length).toBe(32);

    const values = await dump(factory, databaseName(vaultId));
    // The dump reads what unlock reads: the Master Key wrap is in it.
    const db = await VaultDatabase.open(vaultId, factory);
    databases.push(db);
    const config = parseLocalConfig((await db.localConfig()) ?? new Uint8Array(0));
    expect(config.prf).toBeDefined();
    expect(values.some((bytes) => contains(bytes, config.kek.mkWrap.c))).toBe(true);
    const found = needles.filter((needle) => values.some((bytes) => contains(bytes, needle)));
    expect(found).toEqual([]);
  });
});
