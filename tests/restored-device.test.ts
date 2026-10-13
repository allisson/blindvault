// Phase 2: a fresh restore through the IndexedDB store writes no Device record, and an
// unregistered device retires a device that no longer exists, as stored (§10, D30, D41, D186).

import { parseBackup, restoreWithPhrase } from '@blindvault/backup';
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
import { type RecordStore, VaultSession, parseLocalConfig } from '@blindvault/vault';
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
  return {
    store,
    db: () => {
      if (!db) throw new Error('no database');
      return db;
    },
  };
}

function hexes(records: readonly { readonly envelope: Uint8Array }[]): string[] {
  return records.map((r) => Buffer.from(r.envelope).toString('hex')).sort();
}

describe('restored device through IndexedDB (§10, D30, D41, D186)', () => {
  it('writes no Device record, then retires the old device as stored', async () => {
    const keyringA = new Keyring();
    const phrase = generateRecoveryPhrase(keyringA);
    const a = await VaultSession.create({
      store: lazyStore(new IDBFactory()).store,
      keyring: keyringA,
      kek: kek(keyringA, 1),
      recoveryEntropy: phrase.entropy,
      salt: new Uint8Array(16).fill(7),
      kdfParams: PARAMS,
      displayName: 'Lost laptop',
      now: () => T0,
    });
    sessions.push(a);
    await a.createItem({
      templateId: 'login',
      templateVersion: 1,
      title: 'Bank',
      fields: [{ type: 'secret', role: 'password', value: 'hunter2-very-secret' }],
      tags: [],
    });
    const file = await a.exportBackup({ kek: kek(keyringA, 1), method: 'password' });

    const keyring = new Keyring();
    const backup = restoreWithPhrase(keyring, parseBackup(file.bytes), phrase.words);
    const factory = new IDBFactory();
    const { store, db } = lazyStore(factory, backup.vaultId);
    const b = await VaultSession.restore({
      store,
      keyring,
      kek: kek(keyring, 2),
      salt: new Uint8Array(16).fill(9),
      kdfParams: PARAMS,
      backup,
      now: () => T0 + 1000,
    });
    sessions.push(b);
    const devices = (await db().records()).filter((r) => r.recordType === RecordType.device);
    expect(hexes(devices)).toEqual(
      hexes(backup.records.filter((r) => r.recordType === RecordType.device)),
    );
    expect(b.registered).toBe(false);

    await b.retireDevice(a.deviceId);
    b.lock();
    const again = new Keyring();
    const database = db();
    const reopened = await VaultSession.unlock({
      store: { records: () => database.records(), commit: (c) => database.commit(c) },
      localConfig: parseLocalConfig((await database.localConfig()) ?? new Uint8Array()),
      keyring: again,
      kek: kek(again, 2),
      method: 'password',
      now: () => T0 + 2000,
    });
    sessions.push(reopened);
    expect(reopened.registered).toBe(false);
    expect(reopened.devices().map((d) => [d.device.displayName, d.device.retired])).toEqual([
      ['Lost laptop', true],
    ]);
    expect(
      (await database.records()).filter((r) => r.recordType === RecordType.device),
    ).toHaveLength(1);
  });
});
