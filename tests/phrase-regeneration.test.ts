// Gate B (Phase 2): regenerating the Recovery Phrase through the IndexedDB store changes no vault
// content, and the new phrase restores the new backup (§5.4, D2, D185).

import { BackupRejectedError, parseBackup, restoreWithPhrase } from '@blindvault/backup';
import {
  Keyring,
  MEMLIMIT,
  RecordType,
  type SymmetricKey,
  derivePrfKek,
  generateRecoveryPhrase,
  initCrypto,
} from '@blindvault/crypto';
import { VaultDatabase } from '@blindvault/storage';
import {
  type ItemInput,
  type RecordStore,
  VaultSession,
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
  return {
    templateId: 'login',
    templateVersion: 1,
    title,
    fields: [{ type: 'secret', role: 'password', value: 'hunter2-very-secret' }],
    tags: [],
  };
}

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing');
  return value;
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
  return { store, db: () => must(db) };
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/** Every stored record but the Recovery Envelope, by identity, as bytes. */
async function contents(db: VaultDatabase): Promise<Map<string, string>> {
  const records = await db.records();
  return new Map(
    records
      .filter((r) => r.recordType !== RecordType.recoveryEnvelope)
      .map((r) => [`${String(r.recordType)}:${hex(r.recordId)}`, hex(r.envelope)]),
  );
}

async function exported(session: VaultSession): Promise<Uint8Array> {
  const keyring = new Keyring();
  const file = await session.exportBackup({ kek: kek(keyring, 1), method: 'password' });
  keyring.wipeAll();
  return file.bytes;
}

function restores(file: Uint8Array, words: string) {
  const keyring = new Keyring();
  try {
    return restoreWithPhrase(keyring, parseBackup(file), words).records;
  } finally {
    keyring.wipeAll();
  }
}

describe('Recovery Phrase regeneration through IndexedDB (Gate B, D2, D185)', () => {
  it('changes no vault content, and the new phrase restores the new backup', async () => {
    const factory = new IDBFactory();
    const { store, db } = lazyStore(factory);
    const keyring = new Keyring();
    const first = generateRecoveryPhrase(keyring);
    const clock = { t: T0 };
    const session = await VaultSession.create({
      store,
      keyring,
      kek: kek(keyring, 1),
      recoveryEntropy: first.entropy,
      salt: new Uint8Array(16).fill(7),
      kdfParams: PARAMS,
      displayName: 'Chrome on macOS',
      now: () => clock.t,
    });
    sessions.push(session);
    const id = await session.createItem(login('Bank'));
    await session.updateItem(id, login('Bank, renamed'));
    await session.createFolder('Work');
    const oldBackup = await exported(session);
    const before = await contents(db());

    clock.t = T0 + 60_000;
    const caller = new Keyring();
    const next = generateRecoveryPhrase(caller);
    const recovery = await session.regenerateRecoveryPhrase({
      kek: kek(caller, 1),
      method: 'password',
      entropy: next.entropy,
    });
    caller.wipeAll();

    // Vault contents: every other record is unchanged, byte for byte.
    expect(await contents(db())).toEqual(before);
    const database = db();
    const unlockKeyring = new Keyring();
    const again = await VaultSession.unlock({
      store: { records: () => database.records(), commit: (c) => database.commit(c) },
      localConfig: parseLocalConfig(must(await database.localConfig())),
      keyring: unlockKeyring,
      kek: kek(unlockKeyring, 1),
      method: 'password',
      now: () => clock.t,
    });
    sessions.push(again);
    expect(again.recovery).toEqual(recovery);
    expect(again.lastPhraseId).toEqual(recovery.phraseId);
    expect(again.item(id)?.item?.title).toBe('Bank, renamed');
    expect(again.versions(id).map((v) => v.item?.title)).toEqual(['Bank']);
    expect(again.corrupt()).toEqual([]);

    // The new backup restores with the new phrase into a new installation, every record matching.
    const newBackup = await exported(again);
    expect(hex(parseBackup(newBackup).header.phraseId)).toBe(hex(recovery.phraseId));
    const records = restores(newBackup, next.words);
    expect(records.map((r) => hex(r.envelope)).sort()).toEqual(
      (await database.records()).map((r) => hex(r.envelope)).sort(),
    );
    const restoreKeyring = new Keyring();
    const backup = restoreWithPhrase(restoreKeyring, parseBackup(newBackup), next.words);
    const target = lazyStore(new IDBFactory(), backup.vaultId);
    const restored = await VaultSession.restore({
      store: target.store,
      keyring: restoreKeyring,
      kek: kek(restoreKeyring, 2),
      salt: new Uint8Array(16).fill(9),
      kdfParams: PARAMS,
      backup,
      now: () => clock.t,
    });
    sessions.push(restored);
    expect(restored.item(id)?.item?.title).toBe('Bank, renamed');
    expect(restored.recovery).toEqual(recovery);
    expect(restored.checkRecoveryPhrase(next.words)).toBe('opens');

    // The old phrase does not open the new backup; the old backup still opens only with it.
    expect(() => restores(newBackup, first.words)).toThrow(BackupRejectedError);
    expect(restores(oldBackup, first.words).length).toBeGreaterThan(0);
    expect(() => restores(oldBackup, next.words)).toThrow(BackupRejectedError);

    // Neither phrase reaches IndexedDB (CRYPTO-INV-006).
    const stored = [
      must(await database.localConfig()),
      ...(await database.records()).map((r) => r.envelope),
    ].map((b) => Buffer.from(b).toString('latin1'));
    for (const words of [first.words, next.words]) {
      const list = words.split(' ');
      for (let i = 0; i + 1 < list.length; i++) {
        const pair = `${list[i] ?? ''} ${list[i + 1] ?? ''}`;
        expect(stored.some((s) => s.includes(pair))).toBe(false);
      }
    }
  });
});
