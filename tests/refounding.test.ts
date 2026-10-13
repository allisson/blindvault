// Gate B (Phase 2): re-founding through IndexedDB (§14, D28, D89, D93, D96, D187). The old vault
// stays intact until the new one commits, the startup cleanup finishes a re-founding interrupted
// after that commit, and old backups neither merge into nor open the new vault.

import { BackupRejectedError, parseBackup, restoreWithPhrase } from '@blindvault/backup';
import {
  Keyring,
  MEMLIMIT,
  type SymmetricKey,
  derivePrfKek,
  generateRecoveryPhrase,
  initCrypto,
} from '@blindvault/crypto';
import {
  VaultDatabase,
  acquireInstallationGuard,
  cleanupDatabases,
  databaseName,
} from '@blindvault/storage';
import {
  type ItemInput,
  MergeRejectedError,
  VaultSession,
  localConfigWithoutReplaces,
  parseLocalConfig,
} from '@blindvault/vault';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

beforeAll(initCrypto);

const T0 = 1_760_000_000_000;
const PARAMS = { opslimit: 2, memlimit: MEMLIMIT };

/** A reproducible KEK: a PRF KEK of a fixed output, standing in for Argon2id here. */
function kek(keyring: Keyring, seed: number): SymmetricKey {
  const authenticatorData = new Uint8Array(37);
  authenticatorData[32] = 0x05;
  return derivePrfKek(keyring, { authenticatorData, prfOutput: new Uint8Array(32).fill(seed) });
}

function login(title: string): ItemInput {
  return { templateId: 'login', templateVersion: 1, title, fields: [], tags: [] };
}

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('missing');
  return value;
}

function hexes(records: readonly { readonly envelope: Uint8Array }[]): string[] {
  return records.map((r) => Buffer.from(r.envelope).toString('hex')).sort();
}

const sessions: VaultSession[] = [];
const opened: VaultDatabase[] = [];

afterEach(() => {
  for (const s of sessions.splice(0)) s.lock();
  for (const d of opened.splice(0)) d.close();
});

async function database(factory: IDBFactory, vaultId: Uint8Array) {
  const db = await VaultDatabase.open(vaultId, factory);
  opened.push(db);
  return db;
}

/** A vault with one item in `factory`, and its backup by the phrase. */
async function vault(factory: IDBFactory, title: string) {
  let db: VaultDatabase | undefined;
  const keyring = new Keyring();
  const phrase = generateRecoveryPhrase(keyring);
  const session = await VaultSession.create({
    store: {
      records: () => (db ? db.records() : Promise.resolve([])),
      commit: async (commit) => {
        db ??= await database(factory, parseLocalConfig(commit.localConfig).vaultId);
        await db.commit(commit);
      },
    },
    keyring,
    kek: kek(keyring, 1),
    recoveryEntropy: phrase.entropy,
    salt: new Uint8Array(16).fill(7),
    kdfParams: PARAMS,
    displayName: 'Chrome on macOS',
    now: () => T0,
  });
  sessions.push(session);
  await session.createItem(login(title));
  const file = await session.exportBackup({ kek: kek(keyring, 1), method: 'password' });
  return { session, db: must(db), words: phrase.words, file: file.bytes };
}

const reader = {
  replaces: (bytes: Uint8Array) => parseLocalConfig(bytes).replacesVaultId,
  withoutReplaces: localConfigWithoutReplaces,
};

async function cleanup(factory: IDBFactory) {
  const guard = must(await acquireInstallationGuard());
  try {
    return await cleanupDatabases(guard, reader, { factory });
  } finally {
    await guard.release();
  }
}

/** Re-founds `old` into a new database of `factory`, committing only if `commit` is true. */
async function refound(old: Awaited<ReturnType<typeof vault>>, factory: IDBFactory, commit = true) {
  let db: VaultDatabase | undefined;
  const keyring = new Keyring();
  const phrase = generateRecoveryPhrase(keyring);
  const caller = new Keyring();
  const session = await VaultSession.refound(old.session, {
    store: {
      records: () => (db ? db.records() : Promise.resolve([])),
      commit: async (c) => {
        db ??= await database(factory, parseLocalConfig(c.localConfig).vaultId);
        if (!commit) throw new Error('interrupted');
        await db.commit(c);
      },
    },
    keyring,
    kek: kek(keyring, 3),
    recoveryEntropy: phrase.entropy,
    salt: new Uint8Array(16).fill(5),
    kdfParams: PARAMS,
    displayName: 'Re-founded',
    current: { kek: kek(caller, 1), method: 'password' },
    now: () => T0 + 1000,
  });
  caller.wipeAll();
  sessions.push(session);
  return { session, db: must(db), words: phrase.words };
}

describe('re-founding through IndexedDB (Gate B, D28, D89, D96, D187)', () => {
  it('leaves the old vault intact when interrupted before the new database commits', async () => {
    const factory = new IDBFactory();
    const old = await vault(factory, 'Old');
    const oldId = old.session.vaultId;
    const before = hexes(await old.db.records());
    const config = await old.db.localConfig();
    await expect(refound(old, factory, false)).rejects.toThrow('interrupted');
    expect(hexes(await old.db.records())).toEqual(before);
    expect(await old.db.localConfig()).toEqual(config);
    old.session.lock();
    old.db.close();
    for (const d of opened.splice(0)) d.close();

    const report = await cleanup(factory);
    expect(report.vaults).toEqual([databaseName(oldId)]);
    expect(report.deleted).toHaveLength(1);
    expect((await factory.databases()).map((d) => d.name)).toEqual([databaseName(oldId)]);
  });

  it('keeps only the new vault at startup when interrupted after its commit', async () => {
    const factory = new IDBFactory();
    const old = await vault(factory, 'Old');
    const oldId = old.session.vaultId;
    const fresh = await refound(old, factory);
    const newId = fresh.session.vaultId;
    // The app window stops before deleting the old database.
    old.session.lock();
    fresh.session.lock();
    for (const d of opened.splice(0)) d.close();
    old.db.close();

    const report = await cleanup(factory);
    expect(report.deleted).toEqual([databaseName(oldId)]);
    expect(report.vaults).toEqual([databaseName(newId)]);
    const kept = await database(factory, newId);
    expect(parseLocalConfig(must(await kept.localConfig())).replacesVaultId).toBeUndefined();
    const keyring = new Keyring();
    const session = await VaultSession.unlock({
      store: { records: () => kept.records(), commit: (c) => kept.commit(c) },
      localConfig: parseLocalConfig(must(await kept.localConfig())),
      keyring,
      kek: kek(keyring, 3),
      method: 'password',
      now: () => T0 + 2000,
    });
    sessions.push(session);
    expect(session.items().map((i) => i.item?.title)).toEqual(['Old']);
  });

  it('refuses an old backup: it does not merge into the new vault, and the old phrase does not open a new one', async () => {
    const factory = new IDBFactory();
    const old = await vault(factory, 'Old');
    const fresh = await refound(old, factory);

    const keyring = new Keyring();
    const oldBackup = restoreWithPhrase(keyring, parseBackup(old.file), old.words);
    const error = await fresh.session.mergeBackup(oldBackup).catch((e: unknown) => e);
    keyring.wipeAll();
    expect(error).toBeInstanceOf(MergeRejectedError);
    expect((error as MergeRejectedError).reason).toBe('different-vault');

    const caller = new Keyring();
    const file = await fresh.session.exportBackup({ kek: kek(caller, 3), method: 'password' });
    expect(() => restoreWithPhrase(new Keyring(), parseBackup(file.bytes), old.words)).toThrow(
      BackupRejectedError,
    );
    expect(restoreWithPhrase(new Keyring(), parseBackup(file.bytes), fresh.words).vaultId).toEqual(
      fresh.session.vaultId,
    );
  });
});
