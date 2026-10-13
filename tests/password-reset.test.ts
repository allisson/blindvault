// A forgotten local password reset with the Recovery Phrase (overview §14, D173, D184), through
// IndexedDB: only Local Config changes, and every record stays byte for byte.

import {
  Keyring,
  MEMLIMIT,
  type SymmetricKey,
  derivePrfKek,
  generateRecoveryPhrase,
  initCrypto,
  parseRecoveryPhrase,
} from '@blindvault/crypto';
import { VaultDatabase } from '@blindvault/storage';
import { UnlockRejectedError, VaultSession, parseLocalConfig } from '@blindvault/vault';
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

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing');
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

describe('forgotten password reset through IndexedDB (D173, D184)', () => {
  it('rewrites only the Master Key wrap, and the new password unlocks every record', async () => {
    const factory = new IDBFactory();
    let db: VaultDatabase | undefined;
    const store = {
      records: () => (db ? db.records() : Promise.resolve([])),
      commit: async (commit: Parameters<VaultDatabase['commit']>[0]) => {
        if (!db) {
          db = await VaultDatabase.open(parseLocalConfig(commit.localConfig).vaultId, factory);
          opened.push(db);
        }
        await db.commit(commit);
      },
    };
    const keyring = new Keyring();
    const phrase = generateRecoveryPhrase(keyring);
    const created = await VaultSession.create({
      store,
      keyring,
      kek: kek(keyring, 1),
      recoveryEntropy: phrase.entropy,
      salt: new Uint8Array(16).fill(7),
      kdfParams: PARAMS,
      displayName: 'Chrome on macOS',
      now: () => T0,
    });
    await created.createItem({
      templateId: 'login',
      templateVersion: 1,
      title: 'Bank',
      fields: [{ type: 'secret', role: 'password', value: 'hunter2-very-secret' }],
      tags: [],
    });
    created.lock();
    const database = must(db);
    const records = hexes(await database.records());
    const before = parseLocalConfig(must(await database.localConfig()));

    const resetKeys = new Keyring();
    const reset = await VaultSession.resetPassword({
      store,
      localConfig: before,
      keyring: resetKeys,
      entropy: parseRecoveryPhrase(resetKeys, phrase.words),
      kek: kek(resetKeys, 2),
      salt: new Uint8Array(16).fill(9),
      kdfParams: PARAMS,
      now: () => T0,
    });
    reset.lock();

    expect(hexes(await database.records())).toEqual(records);
    const after = parseLocalConfig(must(await database.localConfig()));
    expect(after.vaultId).toEqual(before.vaultId);
    expect(after.localConfigId).toEqual(before.localConfigId);
    expect(after.kek.mkWrap).not.toEqual(before.kek.mkWrap);
    expect(after.kek.salt).toEqual(new Uint8Array(16).fill(9));

    const unlock = (seed: number) => {
      const k = new Keyring();
      return VaultSession.unlock({
        store,
        localConfig: after,
        keyring: k,
        kek: kek(k, seed),
        method: 'password',
        now: () => T0,
      });
    };
    await expect(unlock(1)).rejects.toThrow(UnlockRejectedError);
    const again = await unlock(2);
    sessions.push(again);
    expect(again.items().map((i) => i.item?.title)).toEqual(['Bank']);
    expect(again.corrupt()).toEqual([]);
  });
});
