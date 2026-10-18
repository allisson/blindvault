// Gate D (Phase 5): a sync end to end over the in-memory transport, through the real `Noise_KK`
// handshake, the summaries, the selection of §8 and the transfer of §9, with both vaults in
// IndexedDB (sync-protocol.md §1, §7 to §9, D6, D56, D222, D223). The app wires sync to the vault
// the same way, with the checks of §6 and `committed` around it.

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
import { SyncSession, exchange, memoryPair, syncHandshake } from '@blindvault/sync';
import {
  HISTORY_LIMIT,
  type ItemInput,
  MAINTENANCE_INTERVAL_MS,
  PURGE_DELAY_MS,
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

/**
 * X created the vault with one item; Y restored its backup; both re-admitted: each holds the other.
 * Y's clock runs `clock.y` ms off X's.
 */
async function peers() {
  const clock = { t: T0, y: 0 };
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
    now: () => clock.t + clock.y,
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

describe('the history cut over a sync (sync-protocol.md §1.4, D6, D70)', () => {
  it('cuts both to the same 20 versions in one sync, telling only the device that wrote the dropped loser', async () => {
    const { clock, x, y, shared } = await peers();
    clock.t = T0 + MINUTE;
    await x.updateItem(shared, login('Edited on Laptop'));
    for (let i = 0; i <= HISTORY_LIMIT; i++) {
      clock.t = T0 + 2 * MINUTE + i;
      await y.updateItem(shared, login(`Phone ${String(i)}`));
    }
    const [rx, ry] = await sync(x, y);
    expect(rx.droppedLosers).toEqual([{ itemId: shared, title: 'Edited on Laptop' }]);
    expect(ry.droppedLosers).toEqual([]);
    for (const session of [x, y]) {
      expect(titleOf(session, shared)).toBe(`Phone ${String(HISTORY_LIMIT)}`);
      expect(history(session, shared)).toHaveLength(HISTORY_LIMIT);
      expect(history(session, shared)).not.toContain('Edited on Laptop');
    }
    expect(history(x, shared)).toEqual(history(y, shared));
    expect(held(x)).toEqual(held(y));
  });

  it('cuts two histories of fewer than 20 each to the same 20 of their union, with no notice', async () => {
    const { clock, x, y, shared } = await peers();
    const edits = 11;
    for (let i = 0; i < edits; i++) {
      clock.t = T0 + MINUTE + i;
      await x.updateItem(shared, login(`Laptop ${String(i)}`));
    }
    for (let i = 0; i < edits; i++) {
      clock.t = T0 + 2 * MINUTE + i;
      await y.updateItem(shared, login(`Phone ${String(i)}`));
    }
    expect(history(x, shared)).toHaveLength(edits);
    expect(history(y, shared)).toHaveLength(edits);
    const results = await sync(x, y);
    for (const result of results) expect(result.droppedLosers).toEqual([]);
    for (const session of [x, y]) {
      expect(history(session, shared)).toHaveLength(HISTORY_LIMIT);
      // The two oldest of 22 go: the state both started from and the Laptop's first edit.
      expect(history(session, shared)).not.toContain('Shared');
      expect(history(session, shared)).not.toContain('Laptop 0');
      // The Laptop's last edit lost, and is kept.
      expect(history(session, shared)).toContain(`Laptop ${String(edits - 1)}`);
    }
    expect(held(x)).toEqual(held(y));
  });

  it('brings back nothing the cut dropped on a second sync', async () => {
    const { clock, x, y, shared } = await peers();
    clock.t = T0 + MINUTE;
    await x.updateItem(shared, login('Edited on Laptop'));
    for (let i = 0; i <= HISTORY_LIMIT; i++) {
      clock.t = T0 + 2 * MINUTE + i;
      await y.updateItem(shared, login(`Phone ${String(i)}`));
    }
    await sync(x, y);
    const before = held(x);
    for (const result of await sync(x, y)) {
      expect(result).toMatchObject({ added: 0, replaced: 0, versions: 0, droppedLosers: [] });
    }
    expect(held(x)).toEqual(before);
    expect(held(y)).toEqual(before);
  });
});

/** Runs the maintenance pass of every open session (D7), then waits for `check`: it commits to IndexedDB, whose timers are real. */
async function maintenance(check: () => void): Promise<void> {
  await vi.advanceTimersByTimeAsync(MAINTENANCE_INTERVAL_MS);
  await vi.waitFor(check);
}

/** The summary entry of an item, or of a record of `type`, as the session would send it. */
function entryOf(session: VaultSession, id: Uint8Array, type: RecordType = RecordType.item) {
  const peer = session.devices().find((d) => !same(d.deviceId, session.deviceId));
  if (!peer) throw new Error('no peer');
  return session
    .openSync(peer.deviceId)
    .summary()
    .find((e) => e.recordType === type && same(e.recordId, id));
}

describe('tombstones over a sync (sync-protocol.md §1.3, §8, D27, CRYPTO-INV-013)', () => {
  it("purges a stale device's older edit with the tombstone, keeping the tombstone on both and telling the writer", async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { clock, x, y, shared } = await peers();
    clock.t = T0 + MINUTE;
    await y.updateItem(shared, login('Edited on Phone'));
    clock.t = T0 + 2 * MINUTE;
    await x.trashItem(shared);
    clock.t = T0 + 32 * DAY;
    await maintenance(() => {
      expect(x.item(shared)).toBeUndefined();
    });

    const [rx, ry] = await sync(x, y);
    expect(ry.droppedLosers).toEqual([{ itemId: shared, title: 'Edited on Phone' }]);
    expect(rx.droppedLosers).toEqual([]);
    for (const session of [x, y]) {
      expect(session.item(shared)).toBeUndefined();
      expect(session.versions(shared)).toEqual([]);
      expect(entryOf(session, shared)).toMatchObject({ deleted: true });
    }
    expect(held(x)).toEqual(held(y));
  });

  it('trashes a folder and its item on both over older edits of either (D27)', async () => {
    const { clock, x, y } = await peers();
    const folder = await x.createFolder('Work');
    const item = await x.createItem({ ...login('In Work'), folderId: folder });
    await sync(x, y);
    clock.t = T0 + MINUTE;
    await y.renameFolder(folder, 'Work on Phone');
    await y.updateItem(item, { ...login('Edited on Phone'), folderId: folder });
    clock.t = T0 + 2 * MINUTE;
    await x.trashFolder(folder);

    await sync(x, y);
    for (const session of [x, y]) {
      expect(session.folder(folder)).toMatchObject({ inTrash: true, name: 'Work' });
      expect(session.item(item)).toMatchObject({ inTrash: true });
      expect(history(session, item)).toContain('Edited on Phone');
    }
    expect(held(x)).toEqual(held(y));
  });

  it('keeps a purged tombstone of an item it never held, and nothing changes on a second sync', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { clock, x, y } = await peers();
    const later = await x.createItem(login('Created after the restore'));
    await x.trashItem(later);
    clock.t = T0 + 31 * DAY;
    await maintenance(() => {
      expect(x.item(later)).toBeUndefined();
    });

    const [, ry] = await sync(x, y);
    expect(ry).toMatchObject({ added: 1, rejected: [] });
    expect(y.item(later)).toBeUndefined();
    expect(y.items().map((i) => i.item?.title)).toEqual(['Shared']);
    expect(entryOf(y, later)).toMatchObject({ deleted: true });
    expect(held(x)).toEqual(held(y));
    for (const result of await sync(x, y)) {
      expect(result).toMatchObject({ added: 0, replaced: 0, versions: 0, rejected: [] });
    }
  });

  it("sends nothing between a purged and an unpurged copy of one tombstone, which converge at the slower device's own purge (§8)", async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { clock, x, y, shared } = await peers();
    clock.t = T0 + MINUTE;
    await x.trashItem(shared);
    await sync(x, y);
    // X's clock is past the purge date; Y's, an hour behind, is not yet.
    clock.y = -60 * MINUTE;
    clock.t = T0 + MINUTE + 30 * DAY + 30 * MINUTE;
    await maintenance(() => {
      expect(x.item(shared)).toBeUndefined();
    });
    expect(titleOf(y, shared)).toBe('Shared');

    // Identical entries: neither copy is sent (the residual risk of overview §9). Y's version of the
    // item reaches X, which drops it for the purged item (D137).
    expect(entryOf(x, shared)).toEqual(entryOf(y, shared));
    for (const result of await sync(x, y)) {
      expect(result).toMatchObject({ added: 0, replaced: 0, versions: 0 });
    }
    expect(y.item(shared)).toMatchObject({ inTrash: true });

    clock.y = 0;
    await maintenance(() => {
      expect(y.item(shared)).toBeUndefined();
    });
    expect(held(x)).toEqual(held(y));
  });
});

describe('the trash and its purge over a sync (sync-protocol.md §1.3, §1.4, D7, D27, D94)', () => {
  it.each(['x', 'y'] as const)(
    'shows the same purge date on both, from the HLC of the tombstone, whichever device trashed (%s)',
    async (trasher) => {
      const { clock, x, y, shared } = await peers();
      // Y's clock runs an hour behind X's: the date comes from the tombstone, not from either clock.
      clock.y = -60 * MINUTE;
      clock.t = T0 + 2 * 60 * MINUTE;
      const from = trasher === 'x' ? x : y;
      await from.trashItem(shared);
      await sync(x, y);
      const tombstone = entryOf(from, shared);
      for (const session of [x, y]) {
        expect(session.item(shared)).toMatchObject({
          inTrash: true,
          purgeAt: (tombstone?.hlc.physicalMs ?? 0) + PURGE_DELAY_MS,
        });
      }
      expect(held(x)).toEqual(held(y));
    },
  );

  it('purges on arrival an item in the trash past its date that the sender has not purged yet, with its history (D137)', async () => {
    const { clock, x, y } = await peers();
    clock.t = T0 + MINUTE;
    const later = await y.createItem(login('Created on Phone'));
    await y.updateItem(later, login('Edited on Phone'));
    await y.trashItem(later);
    // X's clock is past the purge date; Y's, an hour behind, is not yet.
    clock.y = -60 * MINUTE;
    clock.t = T0 + MINUTE + PURGE_DELAY_MS + 30 * MINUTE;
    expect(history(y, later)).toHaveLength(2);

    const [rx] = await sync(x, y);
    expect(rx).toMatchObject({ added: 1, rejected: [], droppedLosers: [] });
    expect(x.item(later)).toBeUndefined();
    expect(x.versions(later)).toEqual([]);
    // The tombstone is kept, under the header Y sent.
    expect(entryOf(x, later)).toMatchObject({ deleted: true });
    expect(entryOf(x, later)).toEqual(entryOf(y, later));
    expect(y.item(later)).toMatchObject({ inTrash: true });
  });

  it('purges on arrival a folder in the trash past its date that the sender has not purged yet', async () => {
    const { clock, x, y } = await peers();
    clock.t = T0 + MINUTE;
    const folder = await y.createFolder('Created on Phone');
    await y.trashFolder(folder);
    clock.y = -60 * MINUTE;
    clock.t = T0 + MINUTE + PURGE_DELAY_MS + 30 * MINUTE;

    const [rx] = await sync(x, y);
    expect(rx).toMatchObject({ rejected: [] });
    expect(x.folder(folder)).toBeUndefined();
    expect(entryOf(x, folder, RecordType.folder)).toMatchObject({ deleted: true });
    expect(entryOf(x, folder, RecordType.folder)).toEqual(entryOf(y, folder, RecordType.folder));
    expect(y.folder(folder)).toMatchObject({ inTrash: true, name: 'Created on Phone' });
  });
});
