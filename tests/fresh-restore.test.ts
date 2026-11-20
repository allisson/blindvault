// Gate B (Phase 2): a vault backed up, its storage lost, and restored onto another installation
// through the IndexedDB store, with the phrase and with the export password (D33, D39). Attachments
// Gate (Phase 9): a backup's blobs restored after its records, and a version-1 file (D278).

import { readFileSync } from 'node:fs';

import { parseBackup, restoreWithPassword, restoreWithPhrase } from '@blindvault/backup';
import {
  type KdfPort,
  Keyring,
  MEMLIMIT,
  type SymmetricKey,
  derivePrfKek,
  generateRecoveryPhrase,
  initCrypto,
  normalizePassword,
} from '@blindvault/crypto';
import { VaultDatabase } from '@blindvault/storage';
import {
  FUTURE_CLOCK_BOUND_MS,
  type ItemInput,
  type RecordStore,
  VaultSession,
  parseLocalConfig,
} from '@blindvault/vault';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { joined } from './backup-file';
import { attachment } from './blobs';

beforeAll(initCrypto);

const T0 = 1_760_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const PARAMS = { opslimit: 2, memlimit: MEMLIMIT };
const EXPORT_PASSWORD = 'orbit-tulip-granite-ferry-cedar-pixel';

/** A reproducible KEK: a PRF KEK of a fixed output, standing in for Argon2id here. */
function kek(keyring: Keyring, seed: number): SymmetricKey {
  const authenticatorData = new Uint8Array(37);
  authenticatorData[32] = 0x05;
  return derivePrfKek(keyring, { authenticatorData, prfOutput: new Uint8Array(32).fill(seed) });
}

/** A stand-in for the Argon2id worker: the key is the password's bytes. */
function kdf(): KdfPort {
  const port: KdfPort = {
    onmessage: null,
    onerror: null,
    postMessage(message) {
      const key = new Uint8Array(32);
      key.set(message.password.subarray(0, 32));
      message.password.fill(0);
      const params = message.op === 'derive' ? message.params : PARAMS;
      queueMicrotask(() => port.onmessage?.({ data: { ok: true, key, params } }));
    },
    terminate() {
      // nothing runs in the background
    },
  };
  return port;
}

function login(title: string): ItemInput {
  return {
    templateId: 'login',
    templateVersion: 1,
    title,
    fields: [{ type: 'secret', role: 'password', value: 'hunter2-very-secret' }],
    tags: [],
  };
}

const sessions: VaultSession[] = [];
const opened: VaultDatabase[] = [];

afterEach(() => {
  for (const s of sessions.splice(0)) s.lock();
  for (const d of opened.splice(0)) d.close();
});

/** A store that opens the vault's database at its first commit, as the app does. */
function lazyStore(factory: IDBFactory, vaultId?: Uint8Array) {
  let db: VaultDatabase | undefined;
  const store: RecordStore = {
    records: () => (db ? db.records() : Promise.resolve([])),
    record: (key) => (db ? db.record(key) : Promise.resolve(undefined)),
    blobIds: () => (db ? db.blobIds() : Promise.resolve([])),
    deleteBlobs: (ids) => (db ? db.deleteBlobs(ids) : Promise.resolve()),
    blob: (id) => (db ? db.blob(id) : Promise.resolve(undefined)),
    putBlob: (b) => (db ? db.putBlob(b) : Promise.resolve()),
    commit: async (commit) => {
      if (!db) {
        db = await VaultDatabase.open(
          vaultId ?? parseLocalConfig(commit.localConfig).vaultId,
          factory,
        );
        opened.push(db);
      }
      await db.commit(commit);
    },
  };
  return { store, db: () => db };
}

/** A vault with items, folders and history, written through IndexedDB at `at`. */
async function source(at: number) {
  const factory = new IDBFactory();
  const { store, db } = lazyStore(factory);
  const keyring = new Keyring();
  const phrase = generateRecoveryPhrase(keyring);
  const session = await VaultSession.create({
    store,
    keyring,
    kek: kek(keyring, 1),
    recoveryEntropy: phrase.entropy,
    salt: new Uint8Array(16).fill(7),
    kdfParams: PARAMS,
    displayName: 'Chrome on macOS',
    now: () => at,
  });
  sessions.push(session);
  const folder = await session.createFolder('Finance');
  const id = await session.createItem({ ...login('Bank'), folderId: folder });
  await session.updateItem(id, { ...login('Bank of Somewhere'), folderId: folder });
  await session.createItem(login('Mail'));
  const plain = await session.exportBackup({ kek: kek(keyring, 1), method: 'password' });
  const protectedFile = await session.exportBackup({
    kek: kek(keyring, 1),
    method: 'password',
    exportPassword: { password: normalizePassword(EXPORT_PASSWORD), port: kdf() },
  });
  const records = await must(db()).records();
  return {
    words: phrase.words,
    plain: joined(plain),
    protectedFile: joined(protectedFile),
    records,
    session,
  };
}

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing');
  return value;
}

function hexes(records: readonly { readonly envelope: Uint8Array }[]): string[] {
  return records.map((r) => Buffer.from(r.envelope).toString('hex')).sort();
}

/** Restores `file` onto a new installation (another IDBFactory: the storage was lost). */
async function restoreOnto(
  file: Uint8Array,
  open: 'phrase' | 'password',
  words: string,
  at: number,
) {
  const factory = new IDBFactory();
  const keyring = new Keyring();
  const parsed = await parseBackup(file);
  const backup =
    open === 'phrase'
      ? await restoreWithPhrase(keyring, parsed, words)
      : await restoreWithPassword(keyring, kdf(), parsed, normalizePassword(EXPORT_PASSWORD));
  const { store, db } = lazyStore(factory, backup.vaultId);
  const session = await VaultSession.restore({
    store,
    keyring,
    kek: kek(keyring, 2),
    salt: new Uint8Array(16).fill(9),
    kdfParams: PARAMS,
    backup,
    now: () => at,
  });
  sessions.push(session);
  return { session, backup, factory, database: must(db()) };
}

/** The session of `database` unlocked again with the restored device's KEK. */
async function unlocked(database: VaultDatabase, at: number) {
  const keyring = new Keyring();
  const session = await VaultSession.unlock({
    store: {
      records: () => database.records(),
      record: (key) => database.record(key),
      blobIds: () => database.blobIds(),
      deleteBlobs: (ids) => database.deleteBlobs(ids),
      blob: (id) => database.blob(id),
      putBlob: (b) => database.putBlob(b),
      commit: (c) => database.commit(c),
    },
    localConfig: parseLocalConfig(must(await database.localConfig())),
    keyring,
    kek: kek(keyring, 2),
    method: 'password',
    now: () => at,
  });
  sessions.push(session);
  return session;
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

describe('fresh restore through IndexedDB (Gate B, D33)', () => {
  it.each(['phrase', 'password'] as const)(
    'restores every record, opened with the %s, and unlocks again from storage',
    async (via) => {
      const vault = await source(T0);
      const file = via === 'phrase' ? vault.plain : vault.protectedFile;
      const { session, database } = await restoreOnto(file, via, vault.words, T0 + DAY);
      // All records match: the same envelopes, byte for byte.
      expect(hexes(await database.records())).toEqual(hexes(vault.records));
      const titles = (s: VaultSession) =>
        s
          .items()
          .map((i) => i.item?.title)
          .sort();
      expect(titles(session)).toEqual(['Bank of Somewhere', 'Mail']);
      expect(session.folders().map((f) => f.name)).toEqual(['Finance']);

      const config = must(await database.localConfig());
      session.lock();
      const keyring = new Keyring();
      const again = await VaultSession.unlock({
        store: {
          records: () => database.records(),
          record: (key) => database.record(key),
          blobIds: () => database.blobIds(),
          deleteBlobs: (ids) => database.deleteBlobs(ids),
          blob: (id) => database.blob(id),
          putBlob: (b) => database.putBlob(b),
          commit: (c) => database.commit(c),
        },
        localConfig: parseLocalConfig(config),
        keyring,
        kek: kek(keyring, 2),
        method: 'password',
        now: () => T0 + DAY,
      });
      sessions.push(again);
      expect(titles(again)).toEqual(titles(vault.session));
      expect(again.corrupt()).toEqual([]);
    },
  );

  it('keeps every record of a backup whose HLCs are beyond the bound, read-only until within it (D39)', async () => {
    const ahead = T0 + 3 * DAY;
    expect(ahead - FUTURE_CLOCK_BOUND_MS).toBeGreaterThan(T0);
    const vault = await source(ahead);
    const { session, database } = await restoreOnto(vault.plain, 'phrase', vault.words, T0);
    expect(hexes(await database.records())).toEqual(hexes(vault.records));
    const items = session.items();
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.readOnly === 'future-clock')).toBe(true);
    expect(session.folders().every((f) => f.readOnly === 'future-clock')).toBe(true);
    // The restored records do not advance this device's HLC (D109): the vault stays writable.
    expect(session.writable).toBe(true);
    await session.createItem(login('Written here'));
  });
});

describe('the blobs of a backup through IndexedDB (Attachments Gate, D278, D279)', () => {
  it('restores each cited blob after the records commit, and drops a blob no record cites', async () => {
    const factory = new IDBFactory();
    const { store, db } = lazyStore(factory);
    const keyring = new Keyring();
    const phrase = generateRecoveryPhrase(keyring);
    const session = await VaultSession.create({
      store,
      keyring,
      kek: kek(keyring, 1),
      recoveryEntropy: phrase.entropy,
      salt: new Uint8Array(16).fill(7),
      kdfParams: PARAMS,
      displayName: 'Chrome on macOS',
      now: () => T0,
    });
    sessions.push(session);
    // `large` spans several chunks of the stream; `stray` is held but cited by nothing.
    const [passport, large, stray] = [
      attachment('Passport', 1),
      attachment('Scan', 2, 200_000),
      attachment('Stray', 3),
    ];
    await session.createItem(passport.item, [passport.stored]);
    await session.createItem(large.item, [large.stored]);
    await must(db()).putBlob(stray.stored);
    const file = await session.exportBackup({ kek: kek(keyring, 1), method: 'password' });
    expect(file.missing).toEqual([]);

    const restored = await restoreOnto(joined(file), 'phrase', phrase.words, T0 + DAY);
    expect(restored.backup.blobIds.map(hex).sort()).toEqual(
      [passport, large, stray].map((a) => hex(a.blobId)).sort(),
    );
    // Nothing of a blob before step 11.
    expect(await restored.database.blobIds()).toEqual([]);
    expect(await restored.session.restoreBlobs(restored.backup)).toEqual({
      stopped: false,
      missing: [],
    });
    expect((await restored.database.blobIds()).map(hex).sort()).toEqual(
      [passport, large].map((a) => hex(a.blobId)).sort(),
    );
    expect(await restored.database.blob(large.blobId)).toEqual(large.blob);

    restored.session.lock();
    const again = await unlocked(restored.database, T0 + DAY);
    expect(await again.blobGrant().lacking()).toEqual([]);
    expect(await again.blobGrant().read(passport.blobId)).toEqual(passport.blob);
  });

  it('restores a backup of format version 1, which holds no blob', async () => {
    const vectors = JSON.parse(
      readFileSync(
        new URL('../packages/backup/test-vectors/backup-v1.json', import.meta.url),
        'utf8',
      ),
    ) as {
      readonly inputs: { readonly phrase: string };
      readonly valid: readonly { readonly name: string; readonly file: string }[];
    };
    const v1 = must(vectors.valid.find((v) => v.name === 'recoveryOnly'));
    const bytes = new Uint8Array(Buffer.from(v1.file, 'base64'));
    expect(new DataView(bytes.buffer).getUint16(8)).toBe(1);
    const { session, backup, database } = await restoreOnto(
      bytes,
      'phrase',
      vectors.inputs.phrase,
      T0,
    );
    expect(backup.blobIds).toEqual([]);
    expect(await session.restoreBlobs(backup)).toEqual({ stopped: false, missing: [] });
    expect(hexes(await database.records())).toEqual(hexes(backup.records));
    expect(await database.blobIds()).toEqual([]);
  });
});
