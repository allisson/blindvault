// The startup cleanup (D89, D96, D97, D154). A `blindvault-<vaultId>` database is a vault only once
// its Local Config is committed: one without it is a creation, pairing or restore that never
// committed, and is deleted. A committed database that another committed one replaces is deleted
// after it, unless another app window holds its Web Lock.

import { VaultDatabase, databaseName, deleteDatabase, isDatabaseName } from './database';
import { type HeldLock, INSTALLATION_GUARD, acquireVaultLock } from './locks';

/** Reads the cleartext part of Local Config; this package never parses it. */
export interface LocalConfigReader {
  /** The `replacesVaultId` of a Local Config (D96), `undefined` when absent or unreadable. */
  replaces(localConfig: Uint8Array): Uint8Array | undefined;
  /** The same Local Config without `replacesVaultId`. */
  withoutReplaces(localConfig: Uint8Array): Uint8Array;
}

export interface CleanupReport {
  /** Names of the vault databases left, each with a committed Local Config. */
  readonly vaults: readonly string[];
  /** Names of the databases deleted. */
  readonly deleted: readonly string[];
  /** Names left alone: a schema this app does not know, or a replaced vault held elsewhere. */
  readonly skipped: readonly string[];
}

function attempt<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch {
    return undefined;
  }
}

/**
 * Runs the startup cleanup. The caller holds the installation guard (D97) for the whole of it, so
 * no other app window is building a database meanwhile.
 */
export async function cleanupDatabases(
  guard: HeldLock,
  reader: LocalConfigReader,
  {
    factory = indexedDB,
    locks = navigator.locks,
  }: { factory?: IDBFactory; locks?: LockManager } = {},
): Promise<CleanupReport> {
  if (guard.name !== INSTALLATION_GUARD)
    throw new Error('the cleanup runs under the installation guard');
  const names = (await factory.databases())
    .map((d) => d.name)
    .filter((name): name is string => name !== undefined && isDatabaseName(name))
    .sort();
  const deleted: string[] = [];
  const skipped: string[] = [];
  /** Committed databases, kept open: a deletion closes its own connection (`versionchange`). */
  const committed = new Map<string, { db: VaultDatabase; localConfig: Uint8Array }>();

  try {
    for (const name of names) {
      const db = await VaultDatabase.openExisting(factory, name);
      if (!db) {
        skipped.push(name);
        continue;
      }
      const localConfig = await db.localConfig();
      if (localConfig === undefined) {
        db.close();
        await deleteDatabase(factory, name);
        deleted.push(name);
      } else {
        committed.set(name, { db, localConfig });
      }
    }

    for (const name of [...committed.keys()]) {
      const entry = committed.get(name);
      if (!entry) continue; // deleted as replaced earlier in this loop
      const replacesId = attempt(() => reader.replaces(entry.localConfig));
      const replaced = replacesId && attempt(() => databaseName(replacesId));
      if (!replacesId || !replaced || replaced === name) continue;
      if (committed.has(replaced)) {
        // D154: never delete a vault another app window holds, even locked.
        const lock = await acquireVaultLock(replacesId, {}, locks);
        if (!lock) {
          skipped.push(replaced);
          continue;
        }
        try {
          await deleteDatabase(factory, replaced);
        } finally {
          await lock.release();
        }
        committed.delete(replaced);
        deleted.push(replaced);
      } else if (names.includes(replaced) && !deleted.includes(replaced)) {
        continue; // a schema this app does not know: kept, and so is the reference to it
      }
      // D96: the replaced vaultId leaves the cleartext part once its database is gone.
      await entry.db.updateLocalConfig((current) => reader.withoutReplaces(current));
    }
  } finally {
    for (const { db } of committed.values()) db.close();
  }

  return { vaults: [...committed.keys()], deleted, skipped };
}
