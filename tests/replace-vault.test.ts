// Replacing the vault an installation holds by a backup (overview §6, §10, D89, D96, D153): the old
// vault stays intact until the new one commits, and the startup cleanup finishes a replacement
// interrupted after that commit. Through IndexedDB, as `apps/web` drives it.

import { parseBackup, restoreWithPhrase } from '@blindvault/backup';
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

describe('replacing the vault by a backup through IndexedDB (D89, D96, D153)', () => {
  it('finishes at startup a replacement interrupted after the new database committed', async () => {
    const factory = new IDBFactory();
    const old = await vault(factory, 'Old');
    const oldId = old.session.vaultId;
    old.session.lock();
    old.db.close();
    const other = await vault(new IDBFactory(), 'Other');

    // The new vault commits in a database of its own, recording the one it replaces (D96)...
    const keyring = new Keyring();
    const backup = restoreWithPhrase(keyring, parseBackup(other.file), other.words);
    const db = await database(factory, backup.vaultId);
    const session = await VaultSession.restore({
      store: { records: () => db.records(), commit: (c) => db.commit(c) },
      keyring,
      kek: kek(keyring, 2),
      salt: new Uint8Array(16).fill(9),
      kdfParams: PARAMS,
      backup,
      replacesVaultId: oldId,
      now: () => T0,
    });
    session.lock();
    db.close();
    // ...and the app window stops before deleting the old one.
    expect((await factory.databases()).map((d) => d.name).sort()).toEqual(
      [databaseName(oldId), databaseName(backup.vaultId)].sort(),
    );

    const report = await cleanup(factory);
    expect(report.deleted).toEqual([databaseName(oldId)]);
    expect(report.vaults).toEqual([databaseName(backup.vaultId)]);
    const kept = await database(factory, backup.vaultId);
    const config = parseLocalConfig(must(await kept.localConfig()));
    expect(config.replacesVaultId).toBeUndefined();
    expect(hexes(await kept.records())).toEqual(hexes(backup.records));
  });

  it('keeps the old vault whole when the replacement stops before the new database commits', async () => {
    const factory = new IDBFactory();
    const old = await vault(factory, 'Old');
    const oldId = old.session.vaultId;
    const before = hexes(await old.db.records());
    old.session.lock();
    old.db.close();
    const other = await vault(new IDBFactory(), 'Other');
    // The new database was created, as its first commit does, then nothing was committed in it.
    const keyring = new Keyring();
    const backup = restoreWithPhrase(keyring, parseBackup(other.file), other.words);
    keyring.wipeAll();
    (await database(factory, backup.vaultId)).close();

    const report = await cleanup(factory);
    expect(report.deleted).toEqual([databaseName(backup.vaultId)]);
    expect(report.vaults).toEqual([databaseName(oldId)]);
    expect(hexes(await (await database(factory, oldId)).records())).toEqual(before);
  });

  it('replaces a vault by a backup of itself in its own database, in one transaction (D153)', async () => {
    const factory = new IDBFactory();
    const held = await vault(factory, 'Backed up');
    await held.session.createItem(login('Only here'));
    const vaultId = held.session.vaultId;
    held.session.lock();

    const keyring = new Keyring();
    const backup = restoreWithPhrase(keyring, parseBackup(held.file), held.words);
    let clear = true;
    const session = await VaultSession.restore({
      store: {
        records: () => held.db.records(),
        commit: async (commit) => {
          await held.db.commit({ ...commit, clear });
          clear = false;
        },
      },
      keyring,
      kek: kek(keyring, 2),
      salt: new Uint8Array(16).fill(9),
      kdfParams: PARAMS,
      backup,
      now: () => T0,
    });
    sessions.push(session);
    expect(session.items().map((i) => i.item?.title)).toEqual(['Backed up']);
    expect((await factory.databases()).map((d) => d.name)).toEqual([databaseName(vaultId)]);
    // The backup's records, byte for byte, and nothing of the vault it replaced.
    expect(hexes(await held.db.records())).toEqual(hexes(backup.records));
  });
});
