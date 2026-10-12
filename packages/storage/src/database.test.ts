import {
  type CborMap,
  type EncryptedRecord,
  Keyring,
  RECORD_FORMAT_VERSION,
  type RecordEnvelope,
  RecordType,
  generateKey,
  initCrypto,
  randomId,
  sealRecord,
} from '@blindvault/crypto';
import { IDBFactory, IDBRequest } from 'fake-indexeddb';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DATABASE_PREFIX,
  MIGRATIONS,
  type Migration,
  SCHEMA_VERSION,
  VaultDatabase,
  databaseName,
  isDatabaseName,
  openDatabase,
} from './database';
import { StorageClosedError, StorageRejectedError, UnsupportedSchemaError } from './errors';

let factory: IDBFactory;
const keyring = new Keyring();
let vaultKey: ReturnType<typeof generateKey>;
let versionIdKey: ReturnType<typeof generateKey>;
const vaultId = new Uint8Array(16).fill(7);

beforeAll(async () => {
  await initCrypto();
  vaultKey = generateKey(keyring);
  versionIdKey = generateKey(keyring);
});

beforeEach(() => {
  factory = new IDBFactory();
});

function folder(name = 'Taxes', recordId = randomId()): EncryptedRecord {
  const content: CborMap = new Map([['name', name]]);
  const envelope = sealRecord(
    {
      recordFormatVersion: RECORD_FORMAT_VERSION,
      recordType: RecordType.folder,
      recordId,
      keyEpoch: 1,
      hlc: { physicalMs: 1, counter: 0, deviceId: new Uint8Array(16).fill(1) },
      deleted: false,
    },
    { vaultId, versionIdKey },
    vaultKey,
    content,
  );
  return { recordType: RecordType.folder, recordId, envelope };
}

const LOCAL_CONFIG = new Uint8Array([0xa1, 0x61, 0x76, 0x01]);

/** Every value and key held, read straight from IndexedDB. */
async function raw(name: string) {
  const db = await openDatabase(factory, name);
  const tx = db.transaction(['records', 'localConfig']);
  const keys = tx.objectStore('records').getAllKeys();
  const values = tx.objectStore('records').getAll();
  const config = tx.objectStore('localConfig').getAll();
  await new Promise((resolve) => (tx.oncomplete = resolve));
  db.close();
  return {
    keys: keys.result,
    values: values.result as unknown[],
    config: config.result as unknown[],
    stores: [...db.objectStoreNames],
  };
}

describe('vault database (D79, D82, D158)', () => {
  it('is named blindvault-<vaultId> in lowercase hex, and only such names count', () => {
    const name = databaseName(new Uint8Array(16).fill(0xab));
    expect(name).toBe(`${DATABASE_PREFIX}${'ab'.repeat(16)}`);
    expect(isDatabaseName(name)).toBe(true);
    expect(isDatabaseName('blindvault-installation')).toBe(false);
    expect(isDatabaseName(`${DATABASE_PREFIX}${'AB'.repeat(16)}`)).toBe(false);
    expect(isDatabaseName(`${name}0`)).toBe(false);
    expect(() => databaseName(new Uint8Array(15))).toThrow(RangeError);
  });

  it('creates the two object stores and no Local Config', async () => {
    const db = await VaultDatabase.open(vaultId, factory);
    expect(await db.localConfig()).toBeUndefined();
    expect(await db.records()).toEqual([]);
    db.close();
    const { stores } = await raw(databaseName(vaultId));
    expect(stores.sort()).toEqual(['localConfig', 'records']);
    expect((await factory.databases()).map((d) => d.version)).toEqual([SCHEMA_VERSION]);
  });

  it('round-trips records and Local Config, keyed by [recordType, recordId]', async () => {
    const db = await VaultDatabase.open(vaultId, factory);
    const a = folder('a');
    const b = folder('b');
    await db.commit({ put: [a, b], delete: [], localConfig: LOCAL_CONFIG });
    expect(await db.localConfig()).toEqual(LOCAL_CONFIG);
    const held = await db.records();
    expect(held).toHaveLength(2);
    for (const r of [a, b]) {
      expect(held).toContainEqual({
        recordType: r.recordType,
        recordId: r.recordId,
        envelope: r.envelope,
      });
    }
    // Another type under the same recordId is another record (D158).
    const { keys } = await raw(databaseName(vaultId));
    expect(keys).toContainEqual([RecordType.folder, a.recordId.slice().buffer]);
    db.close();
  });

  it('reads each request’s result once, however many records it holds', async () => {
    // Reading `result` per record made unlock quadratic in the number of records in WebKit
    // (architecture.md, load test).
    const db = await VaultDatabase.open(vaultId, factory);
    const records = Array.from({ length: 50 }, (_, i) => folder(`f${String(i)}`));
    await db.commit({ put: records, delete: [], localConfig: LOCAL_CONFIG });
    const result = vi.spyOn(IDBRequest.prototype, 'result', 'get');
    try {
      expect(await db.records()).toHaveLength(50);
      // getAllKeys and getAll: one read each.
      expect(result).toHaveBeenCalledTimes(2);
    } finally {
      result.mockRestore();
      db.close();
    }
  });

  it('deletes and replaces in the same commit as the new Local Config', async () => {
    const db = await VaultDatabase.open(vaultId, factory);
    const a = folder('a');
    const b = folder('b');
    await db.commit({ put: [a, b], delete: [], localConfig: LOCAL_CONFIG });
    const a2 = folder('a2', a.recordId);
    const next = new Uint8Array([1, 2, 3]);
    await db.commit({ put: [a2], delete: [b], localConfig: next });
    const held = await db.records();
    expect(held.map((r) => r.envelope)).toEqual([a2.envelope]);
    expect(await db.localConfig()).toEqual(next);
    db.close();
  });

  it('writes nothing when the transaction fails', async () => {
    const db = await VaultDatabase.open(vaultId, factory);
    const a = folder('a');
    await db.commit({ put: [a], delete: [], localConfig: LOCAL_CONFIG });
    // An invalid key (NaN) throws midway, after the delete of `a` is queued.
    const bad = { ...folder('b'), recordType: Number.NaN as RecordType };
    const failing = { put: [], delete: [a, bad], localConfig: new Uint8Array([9]) };
    await expect(db.commit(failing)).rejects.toThrow();
    expect((await db.records()).map((r) => r.envelope)).toEqual([a.envelope]);
    expect(await db.localConfig()).toEqual(LOCAL_CONFIG);
    db.close();
  });

  it('stores exactly the bytes of each value, never the rest of its buffer', async () => {
    const db = await VaultDatabase.open(vaultId, factory);
    const record = folder('a');
    const marker = new Uint8Array(record.envelope.length + 64).fill(0xee);
    marker.set(record.envelope, 32);
    const view = marker.subarray(32, 32 + record.envelope.length) as RecordEnvelope;
    const id = new Uint8Array(48).fill(0xee);
    id.set(record.recordId, 16);
    const config = new Uint8Array(40).fill(0xee);
    config.set(LOCAL_CONFIG, 8);
    await db.commit({
      put: [{ ...record, recordId: id.subarray(16, 32), envelope: view }],
      delete: [],
      localConfig: config.subarray(8, 8 + LOCAL_CONFIG.length),
    });
    db.close();
    const { values, config: stored } = await raw(databaseName(vaultId));
    const [value] = values as Uint8Array[];
    const [configValue] = stored as Uint8Array[];
    expect(value?.buffer.byteLength).toBe(record.envelope.length);
    expect(configValue?.buffer.byteLength).toBe(LOCAL_CONFIG.length);
  });

  describe('accepts only sealed records (D82)', () => {
    it('refuses bytes that are not an envelope, writing nothing', async () => {
      const db = await VaultDatabase.open(vaultId, factory);
      const plaintext = {
        recordType: RecordType.folder,
        recordId: randomId(),
        envelope: new TextEncoder().encode('{"name":"Taxes"}') as RecordEnvelope,
      };
      await expect(
        db.commit({ put: [folder(), plaintext], delete: [], localConfig: LOCAL_CONFIG }),
      ).rejects.toThrow(StorageRejectedError);
      expect(await db.records()).toEqual([]);
      expect(await db.localConfig()).toBeUndefined();
      db.close();
    });

    it('refuses an envelope stored under another type or ID than its header', async () => {
      const db = await VaultDatabase.open(vaultId, factory);
      const record = folder();
      const otherType = { ...record, recordType: RecordType.item };
      const otherId = { ...record, recordId: randomId() };
      const shorter = { ...record, recordId: record.recordId.subarray(0, 15) };
      for (const r of [otherType, otherId, shorter]) {
        await expect(
          db.commit({ put: [r], delete: [], localConfig: LOCAL_CONFIG }),
        ).rejects.toThrow('record key does not match its header');
      }
      expect(await db.records()).toEqual([]);
      db.close();
    });

    it('refuses a commit without the whole Local Config', async () => {
      const db = await VaultDatabase.open(vaultId, factory);
      await expect(
        db.commit({ put: [folder()], delete: [], localConfig: new Uint8Array(0) }),
      ).rejects.toThrow(StorageRejectedError);
      const missing = { put: [], delete: [], localConfig: undefined as unknown as Uint8Array };
      await expect(db.commit(missing)).rejects.toThrow(StorageRejectedError);
      expect(await db.records()).toEqual([]);
      db.close();
    });
  });

  it('hands back values that are not bytes as empty, and skips malformed keys', async () => {
    const db = await VaultDatabase.open(vaultId, factory);
    const record = folder();
    await db.commit({ put: [record], delete: [], localConfig: LOCAL_CONFIG });
    db.close();
    const raw = await openDatabase(factory, databaseName(vaultId));
    const tx = raw.transaction(['records', 'localConfig'], 'readwrite');
    tx.objectStore('records').put('not bytes', [RecordType.folder, record.recordId.slice()]);
    tx.objectStore('records').put(record.envelope.slice(), 'stray');
    tx.objectStore('records').put(record.envelope.slice(), ['folder', record.recordId.slice()]);
    tx.objectStore('records').put(record.envelope.slice(), [RecordType.item]);
    tx.objectStore('localConfig').put({ vaultId: 'x' }, 'localConfig');
    await new Promise((resolve) => (tx.oncomplete = resolve));
    raw.close();
    const again = await VaultDatabase.open(vaultId, factory);
    expect(await again.records()).toEqual([
      { recordType: RecordType.folder, recordId: record.recordId, envelope: new Uint8Array(0) },
    ]);
    expect(await again.localConfig()).toEqual(new Uint8Array(0));
    again.close();
  });

  it('refuses every call once closed, or once another app window changes the database', async () => {
    const db = await VaultDatabase.open(vaultId, factory);
    db.close();
    await expect(db.records()).rejects.toThrow(StorageClosedError);
    const other = await VaultDatabase.open(vaultId, factory);
    // Erase in another app window: this connection closes instead of blocking it.
    await new Promise<void>((resolve, reject) => {
      const request = factory.deleteDatabase(databaseName(vaultId));
      request.onsuccess = () => {
        resolve();
      };
      request.onblocked = () => {
        reject(new Error('blocked'));
      };
    });
    await expect(other.commit({ put: [], delete: [], localConfig: LOCAL_CONFIG })).rejects.toThrow(
      StorageClosedError,
    );
    await expect(other.localConfig()).rejects.toThrow(StorageClosedError);
  });

  describe('migrations', () => {
    it('runs only the missing steps, in order, keeping the data', async () => {
      const db = await VaultDatabase.open(vaultId, factory);
      const record = folder();
      await db.commit({ put: [record], delete: [], localConfig: LOCAL_CONFIG });
      db.close();
      const ran: number[] = [];
      const v2: Migration = (upgraded, tx) => {
        ran.push(2);
        expect(upgraded.objectStoreNames.contains('records')).toBe(true);
        tx.objectStore('records').createIndex('probe', 'missing');
      };
      const first: Migration = (...args) => {
        ran.push(1);
        MIGRATIONS[0]?.(...args);
      };
      const upgraded = await openDatabase(factory, databaseName(vaultId), [first, v2]);
      expect(ran).toEqual([2]);
      expect(upgraded.version).toBe(2);
      upgraded.close();
      const fresh = await openDatabase(factory, databaseName(randomId()), [first, v2]);
      expect(ran).toEqual([2, 1, 2]);
      fresh.close();
    });

    it('refuses a database written by a newer schema, leaving it untouched', async () => {
      const newer = await openDatabase(factory, databaseName(vaultId), [
        ...MIGRATIONS,
        () => undefined,
      ]);
      newer.close();
      await expect(VaultDatabase.open(vaultId, factory)).rejects.toThrow(UnsupportedSchemaError);
      expect(await VaultDatabase.openExisting(factory, databaseName(vaultId))).toBeNull();
      expect((await factory.databases()).map((d) => d.version)).toEqual([SCHEMA_VERSION + 1]);
    });
  });

  describe('Local Config update', () => {
    it('reads and writes in one transaction, and skips a change that fails or returns nothing', async () => {
      const db = await VaultDatabase.open(vaultId, factory);
      await db.updateLocalConfig(() => new Uint8Array([1]));
      expect(await db.localConfig()).toBeUndefined();
      await db.commit({ put: [], delete: [], localConfig: LOCAL_CONFIG });
      await db.updateLocalConfig((current) => new Uint8Array([...current, 0xff]));
      expect(await db.localConfig()).toEqual(new Uint8Array([...LOCAL_CONFIG, 0xff]));
      await db.updateLocalConfig(() => undefined);
      await db.updateLocalConfig(() => new Uint8Array(0));
      await db.updateLocalConfig(() => {
        throw new Error('unreadable');
      });
      expect(await db.localConfig()).toEqual(new Uint8Array([...LOCAL_CONFIG, 0xff]));
      db.close();
    });
  });
});

describe('open failures', () => {
  it('passes on an error other than a newer schema', async () => {
    const failing = {
      open() {
        const request = {
          error: new DOMException('quota', 'QuotaExceededError'),
        } as unknown as IDBOpenDBRequest;
        setTimeout(() => {
          request.onerror?.call(request, new Event('error'));
        });
        return request;
      },
    } as unknown as IDBFactory;
    await expect(VaultDatabase.openExisting(failing, 'x')).rejects.toThrow('quota');
    const silent = {
      open() {
        const request = { error: null } as unknown as IDBOpenDBRequest;
        setTimeout(() => {
          request.onerror?.call(request, new Event('error'));
        });
        return request;
      },
    } as unknown as IDBFactory;
    await expect(VaultDatabase.openExisting(silent, 'x')).rejects.toThrow('IndexedDB open failed');
  });
});
