// Gate D (Phase 5): a sync end to end over the in-memory transport, through the real `Noise_KK`
// handshake, the summaries, the selection of §8 and the transfer of §9, with both vaults in
// IndexedDB (sync-protocol.md §1, §7 to §9, D6, D56, D222, D223). The app wires sync to the vault
// the same way, with the checks of §6 and `committed` around it.

import { parseBackup, restoreWithPhrase } from '@blindvault/backup';
import {
  Keyring,
  MEMLIMIT,
  type SymmetricKey,
  derivePrfKek,
  generateRecoveryPhrase,
  initCrypto,
} from '@blindvault/crypto';
import { VaultDatabase } from '@blindvault/storage';
import { SyncSession, exchange, memoryPair, syncHandshake } from '@blindvault/sync';
import {
  type ItemInput,
  MAINTENANCE_INTERVAL_MS,
  type RecordStore,
  type SyncResult,
  VaultSession,
  parseLocalConfig,
} from '@blindvault/vault';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

beforeAll(initCrypto);

const T0 = 1_760_000_000_000;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
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

const sessions: VaultSession[] = [];
const opened: VaultDatabase[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const s of sessions.splice(0)) s.lock();
  for (const d of opened.splice(0)) d.close();
});

/** A store that opens the vault's database at its first commit, as the app does. */
function lazyStore(factory: IDBFactory): RecordStore {
  let db: VaultDatabase | undefined;
  return {
    records: () => (db ? db.records() : Promise.resolve([])),
    commit: async (commit) => {
      if (!db) {
        db = await VaultDatabase.open(parseLocalConfig(commit.localConfig).vaultId, factory);
        opened.push(db);
      }
      await db.commit(commit);
    },
  };
}

/** X created the vault with one item; Y restored its backup; both re-admitted: each holds the other. */
async function peers() {
  const clock = { t: T0 };
  const now = () => clock.t;
  const keyring = new Keyring();
  const phrase = generateRecoveryPhrase(keyring);
  const x = await VaultSession.create({
    store: lazyStore(new IDBFactory()),
    keyring,
    kek: kek(keyring, 1),
    recoveryEntropy: phrase.entropy,
    salt: new Uint8Array(16).fill(7),
    kdfParams: PARAMS,
    displayName: 'Laptop',
    now,
  });
  sessions.push(x);
  const shared = await x.createItem(login('Shared'));

  const caller = new Keyring();
  const file = await x.exportBackup({ kek: kek(caller, 1), method: 'password' });
  caller.wipeAll();
  const restoring = new Keyring();
  const y = await VaultSession.restore({
    store: lazyStore(new IDBFactory()),
    keyring: restoring,
    kek: kek(restoring, 2),
    salt: new Uint8Array(16).fill(8),
    kdfParams: PARAMS,
    backup: restoreWithPhrase(restoring, parseBackup(file.bytes), phrase.words),
    now,
  });
  sessions.push(y);

  const gx = x.openReadmission();
  const gy = y.openReadmission();
  await gx.admit({ own: false, peer: true }, gy.identity.publicKey, 'Phone', 'Laptop');
  await gy.merge(await gx.records(), gx.identity.publicKey);
  await gx.merge(await gy.records(), gy.identity.publicKey);
  return { clock, x, y, shared };
}

/** One sync between `x` and `y` through `Noise_KK`, the summaries and the transfer. */
async function sync(x: VaultSession, y: VaultSession): Promise<[SyncResult, SyncResult]> {
  const gx = x.openSync(y.deviceId);
  const gy = y.openSync(x.deviceId);
  const link = memoryPair();
  const payload = (fill: number) => ({
    message: new Uint8Array(140).fill(fill),
    fingerprint: new Uint8Array(32).fill(fill + 1),
  });
  const both = { initiator: payload(0x10), responder: payload(0x30) };
  const [hx, hy] = await Promise.all([
    syncHandshake(link.a, {
      role: 'initiator',
      identity: gx.identity,
      peerPublicKey: gx.peerPublicKey,
      ...both,
    }),
    syncHandshake(link.b, {
      role: 'responder',
      identity: gy.identity,
      peerPublicKey: gy.peerPublicKey,
      ...both,
    }),
  ]);
  const sx = new SyncSession(hx.channel);
  const sy = new SyncSession(hy.channel);
  const run = (session: SyncSession, grant: typeof gx) =>
    exchange(session, {
      summary: grant.summary(),
      records: (selected) => grant.records(selected),
      merge: (records) => grant.merge(records),
      retired: () => Promise.reject(new Error('no retirement here')),
    });
  const results = await Promise.all([run(sx, gx), run(sy, gy)]);
  sx.close();
  sy.close();
  return results;
}

/** The summary of every synchronized record, comparable across devices. */
function held(session: VaultSession): string[] {
  const peer = session.devices().find((d) => !same(d.deviceId, session.deviceId));
  if (!peer) throw new Error('no peer');
  return session
    .openSync(peer.deviceId)
    .summary()
    .map((e) =>
      JSON.stringify([
        e.recordType,
        [...e.recordId],
        e.hlc.physicalMs,
        e.hlc.counter,
        [...e.hlc.deviceId],
        e.recordFormatVersion,
        e.deleted,
        e.keyEpoch,
      ]),
    )
    .sort();
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function titleOf(session: VaultSession, id: Uint8Array): string | undefined {
  return session.item(id)?.item?.title;
}

function history(session: VaultSession, id: Uint8Array): (string | undefined)[] {
  return session.versions(id).map((v) => v.item?.title);
}

describe('per-item last-write-wins over a sync (sync-protocol.md §1.2, §1.3, §8, D6, D223)', () => {
  it('keeps the newer of two concurrent edits on both, and the loser in the history of both after one sync', async () => {
    const { clock, x, y, shared } = await peers();
    clock.t = T0 + MINUTE;
    await x.updateItem(shared, login('Edited on Laptop'));
    clock.t = T0 + 2 * MINUTE;
    await y.updateItem(shared, login('Edited on Phone'));
    const [rx, ry] = await sync(x, y);
    for (const session of [x, y]) {
      expect(titleOf(session, shared)).toBe('Edited on Phone');
      // The loser and the state both edits started from, each once (D6).
      expect(history(session, shared).sort()).toEqual(['Edited on Laptop', 'Shared']);
    }
    expect(rx).toMatchObject({ replaced: 1, rejected: [], droppedLosers: [] });
    expect(ry).toMatchObject({ replaced: 0, rejected: [], droppedLosers: [] });
    // The loser is one record with one versionId on both: the devices hold the same records.
    expect(held(x)).toEqual(held(y));
  });

  it('converges the same way whichever device edited last', async () => {
    const { clock, x, y, shared } = await peers();
    clock.t = T0 + MINUTE;
    await y.updateItem(shared, login('Edited on Phone'));
    clock.t = T0 + 2 * MINUTE;
    await x.updateItem(shared, login('Edited on Laptop'));
    await sync(y, x);
    for (const session of [x, y]) {
      expect(titleOf(session, shared)).toBe('Edited on Laptop');
      expect(history(session, shared).sort()).toEqual(['Edited on Phone', 'Shared']);
    }
    expect(held(x)).toEqual(held(y));
  });

  it('stores a losing trash as a version of the trashed state, and the newer edit restores the item (D56)', async () => {
    const { clock, x, y, shared } = await peers();
    clock.t = T0 + MINUTE;
    await x.updateItem(shared, login('Edited, then trashed'));
    await x.trashItem(shared);
    clock.t = T0 + 2 * MINUTE;
    await y.updateItem(shared, login('Edited on Phone'));
    await sync(x, y);
    for (const session of [x, y]) {
      expect(session.item(shared)).toMatchObject({ inTrash: false });
      expect(titleOf(session, shared)).toBe('Edited on Phone');
      // The edit made before the trash exists nowhere else: both keep it.
      expect(history(session, shared)).toContain('Edited, then trashed');
    }
    expect(held(x)).toEqual(held(y));
  });

  it('never lets an older copy win: a newer trash stays in the trash on both (CRYPTO-INV-013)', async () => {
    const { clock, x, y, shared } = await peers();
    clock.t = T0 + MINUTE;
    await y.updateItem(shared, login('Edited on Phone'));
    clock.t = T0 + 2 * MINUTE;
    await x.trashItem(shared);
    await sync(x, y);
    for (const session of [x, y]) {
      expect(session.item(shared)).toMatchObject({ inTrash: true });
      expect(history(session, shared)).toContain('Edited on Phone');
    }
    expect(held(x)).toEqual(held(y));
  });

  it('changes nothing on a second sync once converged', async () => {
    const { clock, x, y, shared } = await peers();
    clock.t = T0 + MINUTE;
    await x.updateItem(shared, login('Edited on Laptop'));
    clock.t = T0 + 2 * MINUTE;
    await y.updateItem(shared, login('Edited on Phone'));
    await sync(x, y);
    const before = held(x);
    const again = await sync(x, y);
    for (const result of again) {
      expect(result).toMatchObject({ added: 0, replaced: 0, versions: 0, rejected: [] });
    }
    expect(held(x)).toEqual(before);
    expect(held(y)).toEqual(before);
  });
});

describe('a purged item over a sync (sync-protocol.md §1.4, D137)', () => {
  it('keeps the versions of a restore from the trash at a device that purged the item', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { clock, x, y, shared } = await peers();
    clock.t = T0 + MINUTE;
    await x.updateItem(shared, login('Edited on Laptop'));
    await x.trashItem(shared);
    await sync(x, y);
    clock.t = T0 + 29 * DAY;
    await x.restoreItem(shared);
    // Y's purge runs at the 30 days of the trash: its tombstone loses its content and history.
    clock.t = T0 + 31 * DAY;
    await vi.advanceTimersByTimeAsync(MAINTENANCE_INTERVAL_MS);
    // The pass commits to IndexedDB, whose timers are real.
    await vi.waitFor(() => {
      expect(y.item(shared)).toBeUndefined();
    });
    expect(y.versions(shared)).toEqual([]);

    const [, ry] = await sync(x, y);
    expect(ry).toMatchObject({ rejected: [], droppedLosers: [] });
    expect(y.item(shared)).toMatchObject({ inTrash: false });
    expect(titleOf(y, shared)).toBe('Edited on Laptop');
    // Before the edit, before the trash and before the restore, on both.
    expect(history(x, shared)).toHaveLength(3);
    expect(history(y, shared)).toEqual(history(x, shared));
    expect(held(x)).toEqual(held(y));
  });
});
