// Gate B (Phase 2): a backup of the same vault merged into it through the IndexedDB store, keeping
// the losing version in history, and a backup of another vault refused (§10, D13, D57, D182).

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
  type ItemInput,
  MergeRejectedError,
  type RecordStore,
  VaultSession,
  parseLocalConfig,
} from '@blindvault/vault';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

beforeAll(initCrypto);

const T0 = 1_760_000_000_000;
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

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing');
  return value;
}

function hexes(records: readonly { readonly envelope: Uint8Array }[]): string[] {
  return records.map((r) => Buffer.from(r.envelope).toString('hex')).sort();
}

/** A vault created on installation A at T0, with one item. */
async function deviceA() {
  const factory = new IDBFactory();
  const { store, db } = lazyStore(factory);
  const keyring = new Keyring();
  const phrase = generateRecoveryPhrase(keyring);
  const clock = { t: T0 };
  const session = await VaultSession.create({
    store,
    keyring,
    kek: kek(keyring, 1),
    recoveryEntropy: phrase.entropy,
    salt: new Uint8Array(16).fill(7),
    kdfParams: PARAMS,
    displayName: 'Chrome on macOS',
    now: () => clock.t,
  });
  sessions.push(session);
  const id = await session.createItem(login('Bank'));
  return { session, keyring, clock, words: phrase.words, id, database: () => must(db()) };
}

/** The vault on installation B, by a fresh restore of A's backup (another IDBFactory). */
async function deviceB(a: Awaited<ReturnType<typeof deviceA>>) {
  const file = await a.session.exportBackup({ kek: kek(a.keyring, 1), method: 'password' });
  const keyring = new Keyring();
  const backup = restoreWithPhrase(keyring, parseBackup(file.bytes), a.words);
  const { store } = lazyStore(new IDBFactory(), backup.vaultId);
  const clock = { t: T0 };
  const session = await VaultSession.restore({
    store,
    keyring,
    kek: kek(keyring, 2),
    salt: new Uint8Array(16).fill(9),
    kdfParams: PARAMS,
    backup,
    now: () => clock.t,
  });
  sessions.push(session);
  return { session, clock, keyring };
}

async function exported(session: VaultSession, seed: number, exportPassword?: string) {
  const keyring = new Keyring();
  const file = await session.exportBackup({
    kek: kek(keyring, seed),
    method: 'password',
    ...(exportPassword
      ? { exportPassword: { password: normalizePassword(exportPassword), port: kdf() } }
      : {}),
  });
  keyring.wipeAll();
  return file.bytes;
}

/** Unlocks A again from what IndexedDB holds. */
async function reopen(a: Awaited<ReturnType<typeof deviceA>>) {
  const database = a.database();
  const keyring = new Keyring();
  const session = await VaultSession.unlock({
    store: { records: () => database.records(), commit: (c) => database.commit(c) },
    localConfig: parseLocalConfig(must(await database.localConfig())),
    keyring,
    kek: kek(keyring, 1),
    method: 'password',
    now: () => a.clock.t,
  });
  sessions.push(session);
  return session;
}

describe('backup merge through IndexedDB (Gate B, D13, D182)', () => {
  it.each(['phrase', 'password'] as const)(
    'preserves the losing version in history, opened with the %s',
    async (via) => {
      const a = await deviceA();
      const b = await deviceB(a);
      a.clock.t = T0 + 1000;
      await a.session.updateItem(a.id, login('Bank, edited on A'));
      b.clock.t = T0 + 2000;
      await b.session.updateItem(a.id, login('Bank, edited on B'));
      const file = await exported(b.session, 2, via === 'password' ? EXPORT_PASSWORD : undefined);

      const keyring = new Keyring();
      const parsed = parseBackup(file);
      const backup =
        via === 'phrase'
          ? restoreWithPhrase(keyring, parsed, a.words)
          : await restoreWithPassword(keyring, kdf(), parsed, normalizePassword(EXPORT_PASSWORD));
      await a.session.mergeBackup(backup);
      keyring.wipeAll();

      const again = await reopen(a);
      expect(again.item(a.id)?.item?.title).toBe('Bank, edited on B');
      expect(again.versions(a.id).map((v) => v.item?.title)).toEqual(['Bank, edited on A', 'Bank']);
      expect(again.corrupt()).toEqual([]);
      // The winning record is stored as the backup carried it, byte for byte.
      const stored = await a.database().records();
      expect(hexes(stored)).toEqual(
        expect.arrayContaining(hexes(backup.records.filter((r) => r.recordType === 1))),
      );
    },
  );

  it('rejects a backup with a different vaultId, writing nothing (D13)', async () => {
    const a = await deviceA();
    const other = await deviceA();
    const file = await exported(other.session, 1);
    const before = hexes(await a.database().records());
    const config = await a.database().localConfig();

    const keyring = new Keyring();
    const backup = restoreWithPhrase(keyring, parseBackup(file), other.words);
    const error = await a.session.mergeBackup(backup).catch((e: unknown) => e);
    keyring.wipeAll();
    expect(error).toBeInstanceOf(MergeRejectedError);
    expect((error as MergeRejectedError).reason).toBe('different-vault');
    expect(hexes(await a.database().records())).toEqual(before);
    expect(await a.database().localConfig()).toEqual(config);
  });
});
