// Gate D (Phase 5): three devices of one vault, each writing items and folders at random, synced in
// random pairs over the in-memory transport while the link fails: cut, a message tampered with, a
// message delivered twice. Whatever failed, a final round of clean syncs leaves the three with the
// same records, the same items and the same folder tree (sync-protocol.md §1, §7 to §9, §12, D14).

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
import {
  type Direction,
  type MemoryPair,
  SyncSession,
  exchange,
  memoryPair,
  syncHandshake,
} from '@blindvault/sync';
import {
  type ItemInput,
  RecordBlockedError,
  type RecordStore,
  type SyncResult,
  VaultSession,
  displayedParents,
  parseLocalConfig,
} from '@blindvault/vault';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

beforeAll(initCrypto);

const T0 = 1_760_000_000_000;
const MINUTE = 60_000;
const PARAMS = { opslimit: 2, memlimit: MEMLIMIT };

/** A reproducible KEK: a PRF KEK of a fixed output, standing in for Argon2id here. */
function kek(keyring: Keyring, seed: number): SymmetricKey {
  const authenticatorData = new Uint8Array(37);
  authenticatorData[32] = 0x05;
  return derivePrfKek(keyring, { authenticatorData, prfOutput: new Uint8Array(32).fill(seed) });
}

function login(title: string, folderId?: Uint8Array): ItemInput {
  return {
    templateId: 'login',
    templateVersion: 1,
    title,
    fields: [{ type: 'secret', role: 'password', value: 'hunter2-very-secret' }],
    tags: [],
    ...(folderId ? { folderId } : {}),
  };
}

const sessions: VaultSession[] = [];
const opened: VaultDatabase[] = [];

afterEach(() => {
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

function idKey(id: Uint8Array): string {
  return Array.from(id, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A small seeded generator (mulberry32), so a failing seed replays the same run. */
function random(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(list: readonly T[]): T | undefined => list[int(list.length)];
  return { next, int, pick };
}

/** Laptop created the vault; Phone and Tablet restored its backup and were re-admitted with it. */
async function devices() {
  const clock = { t: T0 };
  const now = () => clock.t;
  const keyring = new Keyring();
  const phrase = generateRecoveryPhrase(keyring);
  const laptop = await VaultSession.create({
    store: lazyStore(new IDBFactory()),
    keyring,
    kek: kek(keyring, 1),
    recoveryEntropy: phrase.entropy,
    salt: new Uint8Array(16).fill(7),
    kdfParams: PARAMS,
    displayName: 'Laptop',
    now,
  });
  sessions.push(laptop);
  const caller = new Keyring();
  const file = await laptop.exportBackup({ kek: kek(caller, 1), method: 'password' });
  caller.wipeAll();

  const others: VaultSession[] = [];
  for (const [n, name] of [
    [2, 'Phone'],
    [3, 'Tablet'],
  ] as const) {
    const restoring = new Keyring();
    const device = await VaultSession.restore({
      store: lazyStore(new IDBFactory()),
      keyring: restoring,
      kek: kek(restoring, n),
      salt: new Uint8Array(16).fill(n),
      kdfParams: PARAMS,
      backup: restoreWithPhrase(restoring, parseBackup(file.bytes), phrase.words),
      now,
    });
    sessions.push(device);
    const gl = laptop.openReadmission();
    const gd = device.openReadmission();
    await gl.admit({ own: false, peer: true }, gd.identity.publicKey, name, 'Laptop');
    await gd.merge(await gl.records(), gl.identity.publicKey);
    await gl.merge(await gd.records(), gd.identity.publicKey);
    others.push(device);
  }
  const [phone, tablet] = others as [VaultSession, VaultSession];
  // The Phone learns the Tablet's Device record from the Laptop, and the Tablet the Phone's.
  await sync(laptop, phone);
  await sync(laptop, tablet);
  return { clock, all: [laptop, phone, tablet] as const };
}

/** One sync between `x` and `y` through `Noise_KK`, the summaries and the transfer of §7 to §9. */
async function sync(
  x: VaultSession,
  y: VaultSession,
  link: MemoryPair = memoryPair(),
): Promise<[SyncResult, SyncResult]> {
  const gx = x.openSync(y.deviceId);
  const gy = y.openSync(x.deviceId);
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

type Failure = 'cut' | 'tamper' | 'duplicate';

/** A link that fails once, at the `at`-th message sent in `direction`, the handshake's included. */
function failing(failure: Failure, direction: Direction, at: number) {
  let seen = 0;
  let failed = false;
  const link: MemoryPair = memoryPair({
    intercept: (d, message) => {
      if (d !== direction || ++seen !== at) return [message];
      failed = true;
      if (failure === 'cut') {
        link.breakLink();
        return [];
      }
      if (failure === 'duplicate') return [message, message];
      const changed = message.slice();
      changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 1;
      return [changed];
    },
  });
  return { link, failed: () => failed };
}

/** Every synchronized record by its header, comparable across devices. */
function held(session: VaultSession): string[] {
  const peer = session.devices().find((d) => idKey(d.deviceId) !== idKey(session.deviceId));
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

/** What the user sees: the items with their folder and trash state, and the folder tree (D14). */
function shown(session: VaultSession) {
  const items = session
    .items()
    .map((i) =>
      JSON.stringify([
        idKey(i.id),
        i.item?.title,
        i.inTrash,
        i.item?.folderId && idKey(i.item.folderId),
      ]),
    )
    .sort();
  const folders = session.folders();
  const live = folders.filter((f) => !f.inTrash);
  const tree = [...displayedParents(live)].map((e) => JSON.stringify(e)).sort();
  const names = folders.map((f) => JSON.stringify([idKey(f.id), f.name, f.inTrash])).sort();
  return { items, names, tree };
}

const OPS = [
  ...Array<'create-item'>(3).fill('create-item'),
  ...Array<'edit-item'>(3).fill('edit-item'),
  'trash-item',
  'restore-item',
  ...Array<'create-folder'>(2).fill('create-folder'),
  ...Array<'move-folder'>(4).fill('move-folder'),
  'trash-folder',
  'restore-folder',
] as const;

/** One random write on `device`, of the kinds that conflict across devices. */
async function write(
  device: VaultSession,
  name: string,
  rng: ReturnType<typeof random>,
  step: number,
) {
  const items = device.items();
  const live = items.filter((i) => !i.inTrash);
  const trashed = items.filter((i) => i.inTrash && i.item);
  const folders = device.folders();
  const liveFolders = folders.filter((f) => !f.inTrash);
  const folder = () => rng.pick([undefined, ...liveFolders.map((f) => f.id)]);
  const title = `${name} ${String(step)}`;
  const item = rng.pick(live);
  const inTrash = rng.pick(trashed);
  const f = rng.pick(liveFolders);
  const gone = rng.pick(folders.filter((x) => x.inTrash));
  // Creates and moves outweigh trashes, so the tree grows deep enough for moves to cross (D14).
  switch (rng.pick(OPS)) {
    case 'create-item':
      await device.createItem(login(title, folder()));
      return;
    case 'edit-item':
      if (item) await device.updateItem(item.id, login(title, folder()));
      return;
    case 'trash-item':
      if (item) await device.trashItem(item.id);
      return;
    case 'restore-item':
      if (inTrash) await device.restoreItem(inTrash.id);
      return;
    case 'create-folder':
      await device.createFolder(title, folder());
      return;
    case 'move-folder':
      if (!f) return;
      try {
        await device.moveFolder(f.id, folder());
      } catch (error) {
        // Into its own subtree as this device shows it: refused here, made by two devices (D171).
        if (!(error instanceof RecordBlockedError)) throw error;
      }
      return;
    case 'trash-folder':
      if (f) await device.trashFolder(f.id);
      return;
    case 'restore-folder':
      if (gone) await device.restoreFolder(gone.id);
  }
}

describe('simulation with three devices and injected failures (Gate D)', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    'seed %i: random writes and failing syncs in random pairs, then clean syncs leave all three the same',
    async (seed) => {
      const rng = random(seed);
      const { clock, all } = await devices();
      const device = (i: number) => {
        const found = all[i];
        if (!found) throw new Error('no such device');
        return found;
      };
      const count = { syncs: 0, failed: 0 };
      for (let step = 0; step < 150; step++) {
        clock.t += 1 + rng.int(MINUTE);
        if (rng.next() < 0.6) {
          const n = rng.int(3);
          await write(device(n), ['Laptop', 'Phone', 'Tablet'][n] ?? '', rng, step);
          continue;
        }
        const i = rng.int(3);
        const x = device(i);
        const y = device((i + 1 + rng.int(2)) % 3);
        const failure = rng.pick(['cut', 'tamper', 'duplicate', undefined] as const);
        const direction = rng.pick(['a-to-b', 'b-to-a'] as const) ?? 'a-to-b';
        const { link, failed } = failure
          ? failing(failure, direction, 1 + rng.int(10))
          : { link: memoryPair(), failed: () => false };
        const outcome = await sync(x, y, link).then(
          () => 'synced',
          () => 'failed',
        );
        count.syncs++;
        // A sync fails only for the failure injected into it.
        if (outcome === 'failed') {
          expect(failed()).toBe(true);
          count.failed++;
        }
      }
      expect(count.failed).toBeGreaterThan(0);
      expect(count.syncs - count.failed).toBeGreaterThan(0);

      const [laptop, phone, tablet] = all;
      for (const [x, y] of [
        [laptop, phone],
        [phone, tablet],
        [tablet, laptop],
        [laptop, phone],
      ] as const) {
        await sync(x, y);
      }
      for (const device of [phone, tablet]) {
        expect(held(device)).toEqual(held(laptop));
        expect(shown(device)).toEqual(shown(laptop));
      }
      // Converged: one more sync of each pair moves nothing.
      for (const [x, y] of [
        [laptop, phone],
        [phone, tablet],
        [tablet, laptop],
      ] as const) {
        for (const result of await sync(x, y)) {
          expect(result).toMatchObject({ added: 0, replaced: 0, versions: 0, rejected: [] });
        }
      }
    },
  );
});
