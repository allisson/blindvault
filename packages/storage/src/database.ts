// The vault database (architecture.md "IndexedDB layout", D79, D82, D158): `blindvault-<vaultId>`
// with two object stores, `records` keyed by `[recordType, recordId]` and `localConfig`, written in
// one transaction. Only sealed records and Local Config come in.

import {
  type EncryptedRecord,
  ID_LENGTH,
  type RecordEnvelope,
  type RecordType,
  decodeEnvelope,
} from '@blindvault/crypto';

import { StorageClosedError, StorageRejectedError, UnsupportedSchemaError } from './errors';

export const DATABASE_PREFIX = 'blindvault-';
const RECORDS = 'records';
const LOCAL_CONFIG = 'localConfig';
/** The key of the one Local Config value in its object store. */
const LOCAL_CONFIG_KEY = 'localConfig';

/** A schema step: run inside the `versionchange` transaction that moves to its version. */
export type Migration = (db: IDBDatabase, tx: IDBTransaction) => void;

/** `MIGRATIONS[n]` upgrades a database from version `n` to `n + 1`. */
export const MIGRATIONS: readonly Migration[] = [
  (db) => {
    db.createObjectStore(RECORDS);
    db.createObjectStore(LOCAL_CONFIG);
  },
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** A record's storage key (D158). */
export interface StorageKey {
  readonly recordType: RecordType;
  readonly recordId: Uint8Array;
}

/** One atomic write: records put and deleted, and the whole new Local Config (D62, D82). */
export interface StorageCommit {
  readonly put: readonly EncryptedRecord[];
  readonly delete: readonly StorageKey[];
  readonly localConfig: Uint8Array;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** `blindvault-<vaultId>`, the ID in lowercase hex; also the vault's Web Lock name (D79). */
export function databaseName(vaultId: Uint8Array): string {
  if (vaultId.length !== ID_LENGTH) throw new RangeError('vaultId is 16 bytes');
  return DATABASE_PREFIX + hex(vaultId);
}

const NAME = new RegExp(`^${DATABASE_PREFIX}[0-9a-f]{${String(ID_LENGTH * 2)}}$`);

/** Whether `name` is a vault database name. */
export function isDatabaseName(name: string): boolean {
  return NAME.test(name);
}

function done(request: IDBRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve();
    };
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed'));
    };
  });
}

function settled(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error('IndexedDB transaction failed'));
    };
    tx.onabort = () => {
      reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    };
  });
}

/**
 * Opens (creating it when absent) the database `name`, running every missing migration in its
 * `versionchange` transaction. A database at a version this app does not know is refused, never
 * downgraded or rewritten (`UnsupportedSchemaError`).
 */
export function openDatabase(
  factory: IDBFactory,
  name: string,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, migrations.length);
    request.onupgradeneeded = (event) => {
      const tx = request.transaction;
      if (!tx) return;
      for (let v = event.oldVersion; v < migrations.length; v++)
        migrations[v]?.(request.result, tx);
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another app window erasing or upgrading the database is never blocked by this one.
      db.onversionchange = () => {
        db.close();
      };
      resolve(db);
    };
    request.onerror = () => {
      const error = request.error;
      reject(
        error?.name === 'VersionError'
          ? new UnsupportedSchemaError(name)
          : (error ?? new Error('IndexedDB open failed')),
      );
    };
  });
}

/** Deletes the database `name`. */
export function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
  return done(factory.deleteDatabase(name));
}

/** A copy that owns exactly its bytes: IndexedDB stores a view's whole underlying buffer. */
function own(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.slice();
}

function checkRecord(record: EncryptedRecord): void {
  let header;
  try {
    ({ header } = decodeEnvelope(record.envelope));
  } catch {
    throw new StorageRejectedError('not a sealed record envelope');
  }
  if (
    header.recordType !== record.recordType ||
    header.recordId.length !== record.recordId.length ||
    header.recordId.some((b, i) => b !== record.recordId[i])
  ) {
    throw new StorageRejectedError('record key does not match its header');
  }
}

/** The records and Local Config of one vault, in its own database. */
export class VaultDatabase {
  readonly #db: IDBDatabase;
  #closed = false;

  private constructor(db: IDBDatabase) {
    this.#db = db;
    // `openDatabase` closes the connection on `versionchange`; refuse every later call clearly.
    db.addEventListener('versionchange', () => {
      this.#closed = true;
    });
  }

  /** Opens the database of `vaultId`, creating it empty when absent. */
  static async open(vaultId: Uint8Array, factory: IDBFactory = indexedDB): Promise<VaultDatabase> {
    return new VaultDatabase(await openDatabase(factory, databaseName(vaultId)));
  }

  /** Opens the database `name` as it exists; `null` for a database with another schema. */
  static async openExisting(factory: IDBFactory, name: string): Promise<VaultDatabase | null> {
    try {
      return new VaultDatabase(await openDatabase(factory, name));
    } catch (error) {
      if (error instanceof UnsupportedSchemaError) return null;
      throw error;
    }
  }

  #transaction(mode: IDBTransactionMode): IDBTransaction {
    if (this.#closed) throw new StorageClosedError();
    return this.#db.transaction([RECORDS, LOCAL_CONFIG], mode, { durability: 'strict' });
  }

  /**
   * The committed Local Config, `undefined` when none is: the database is not a vault yet (D89).
   * A stored value that is not bytes comes back empty, which unlock reports as corrupt.
   */
  async localConfig(): Promise<Uint8Array | undefined> {
    const tx = this.#transaction('readonly');
    const request = tx.objectStore(LOCAL_CONFIG).get(LOCAL_CONFIG_KEY);
    await settled(tx);
    const value: unknown = request.result;
    if (value === undefined) return undefined;
    return value instanceof Uint8Array ? value : new Uint8Array(0);
  }

  /**
   * Every record held. A key that is not `[recordType, recordId]` is skipped; a value that is not
   * bytes comes back empty, so unlock keeps the record aside as corrupt.
   */
  async records(): Promise<EncryptedRecord[]> {
    const tx = this.#transaction('readonly');
    const store = tx.objectStore(RECORDS);
    const keys = store.getAllKeys();
    const values = store.getAll();
    await settled(tx);
    // Read each `result` once: reading it per record made unlock quadratic in WebKit.
    const allKeys = keys.result;
    const allValues: unknown[] = values.result;
    const out: EncryptedRecord[] = [];
    allKeys.forEach((key, i) => {
      if (!Array.isArray(key) || key.length !== 2) return;
      const [recordType, recordId] = key;
      if (typeof recordType !== 'number' || !(recordId instanceof ArrayBuffer)) return;
      const value = allValues[i];
      out.push({
        recordType: recordType as RecordType,
        recordId: new Uint8Array(recordId),
        // Storage hands back what it accepted as sealed; unlock verifies every record anyway.
        envelope: (value instanceof Uint8Array ? value : new Uint8Array(0)) as RecordEnvelope,
      });
    });
    return out;
  }

  /**
   * Applies `commit` in one transaction: all of it or none of it. Every record put must be a
   * sealed envelope whose header matches its key, checked before anything is written.
   */
  async commit(commit: StorageCommit): Promise<void> {
    commit.put.forEach(checkRecord);
    if (!(commit.localConfig instanceof Uint8Array) || commit.localConfig.length === 0) {
      throw new StorageRejectedError('a commit writes the whole Local Config');
    }
    const tx = this.#transaction('readwrite');
    const result = settled(tx);
    try {
      const records = tx.objectStore(RECORDS);
      for (const d of commit.delete) records.delete([d.recordType, own(d.recordId)]);
      for (const p of commit.put) records.put(own(p.envelope), [p.recordType, own(p.recordId)]);
      tx.objectStore(LOCAL_CONFIG).put(own(commit.localConfig), LOCAL_CONFIG_KEY);
    } catch (error) {
      // A request that throws leaves the earlier ones queued: abort, or they would commit.
      tx.abort();
      await result.catch(() => undefined);
      throw error;
    }
    await result;
  }

  /**
   * Rewrites the Local Config through `change`, read and written in one transaction so a commit
   * from another app window is never reverted. `change` returning `undefined` writes nothing.
   */
  async updateLocalConfig(change: (current: Uint8Array) => Uint8Array | undefined): Promise<void> {
    const tx = this.#transaction('readwrite');
    const store = tx.objectStore(LOCAL_CONFIG);
    const request = store.get(LOCAL_CONFIG_KEY);
    request.onsuccess = () => {
      const value: unknown = request.result;
      if (!(value instanceof Uint8Array)) return;
      let next: Uint8Array | undefined;
      try {
        next = change(value);
      } catch {
        return;
      }
      if (next !== undefined && next.length > 0) store.put(own(next), LOCAL_CONFIG_KEY);
    };
    await settled(tx);
  }

  close(): void {
    this.#closed = true;
    this.#db.close();
  }
}
