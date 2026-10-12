// The vault session written through the IndexedDB store (D82, D163): what reaches IndexedDB is
// sealed records and Local Config only, and a fresh session unlocks from it.

import {
  type CborMap,
  type CborValue,
  Keyring,
  MEMLIMIT,
  type SymmetricKey,
  decodeCbor,
  derivePrfKek,
  initCrypto,
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
  const session = await VaultSession.create({
    store,
    keyring,
    kek: kek(keyring),
    salt: new Uint8Array(16).fill(7),
    kdfParams: { opslimit: 2, memlimit: MEMLIMIT },
    displayName: 'Chrome on macOS',
    now,
  });
  sessions.push(session);
  if (!vaultId) throw new Error('nothing committed');
  return { session, vaultId };
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
});
