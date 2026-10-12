import { type CborMap, decodeCbor, encodeCbor, initCrypto, randomId } from '@blindvault/crypto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { type LocalConfigReader, cleanupDatabases } from './cleanup';
import { MIGRATIONS, VaultDatabase, databaseName, openDatabase } from './database';
import { type HeldLock, acquireInstallationGuard, acquireVaultLock } from './locks';

let factory: IDBFactory;
let guard: HeldLock;

beforeAll(async () => {
  await initCrypto();
});

beforeEach(async () => {
  factory = new IDBFactory();
  const held = await acquireInstallationGuard();
  if (!held) throw new Error('installation guard held elsewhere');
  guard = held;
  return () => guard.release();
});

/** A stand-in Local Config: a CBOR map whose only key here is `replacesVaultId`. */
function config(replaces?: Uint8Array): Uint8Array {
  const map: CborMap = new Map([['localConfigFormatVersion', 1]]);
  if (replaces) map.set('replacesVaultId', replaces);
  return encodeCbor(map);
}

const reader: LocalConfigReader = {
  replaces: (bytes) => {
    const value = (decodeCbor(bytes) as CborMap).get('replacesVaultId');
    return value instanceof Uint8Array ? value : undefined;
  },
  withoutReplaces: (bytes) => {
    const map = decodeCbor(bytes) as CborMap;
    map.delete('replacesVaultId');
    return encodeCbor(map);
  },
};

async function vault(localConfig?: Uint8Array, vaultId = randomId()): Promise<Uint8Array> {
  const db = await VaultDatabase.open(vaultId, factory);
  if (localConfig) await db.commit({ put: [], delete: [], localConfig });
  db.close();
  return vaultId;
}

async function names(): Promise<string[]> {
  return (await factory.databases()).map((d) => d.name ?? '').sort();
}

async function stored(vaultId: Uint8Array): Promise<Uint8Array | undefined> {
  const db = await VaultDatabase.open(vaultId, factory);
  const value = await db.localConfig();
  db.close();
  return value;
}

const run = () => cleanupDatabases(guard, reader, { factory });

describe('startup cleanup (D89, D96, D97, D154)', () => {
  it('runs only under the installation guard', async () => {
    const vaultLock = await acquireVaultLock(randomId());
    if (!vaultLock) throw new Error('unexpected');
    await expect(cleanupDatabases(vaultLock, reader, { factory })).rejects.toThrow(
      'installation guard',
    );
    await vaultLock.release();
  });

  it('deletes every vault database without Local Config, and nothing else', async () => {
    const kept = await vault(config());
    const uncommitted = await vault();
    const other = await openDatabase(factory, 'notes');
    other.close();
    const report = await run();
    expect(report.deleted).toEqual([databaseName(uncommitted)]);
    expect(report.vaults).toEqual([databaseName(kept)]);
    expect(report.skipped).toEqual([]);
    expect(await names()).toEqual([databaseName(kept), 'notes'].sort());
  });

  it('never deletes a database with a schema this app does not know', async () => {
    const name = databaseName(randomId());
    const newer = await openDatabase(factory, name, [...MIGRATIONS, () => undefined]);
    newer.close();
    const report = await run();
    expect(report).toEqual({ vaults: [], deleted: [], skipped: [name] });
    expect(await names()).toEqual([name]);
  });

  it('deletes a committed database another one replaces, then clears the reference', async () => {
    const old = await vault(config());
    const current = await vault(config(old));
    const report = await run();
    expect(report.deleted).toEqual([databaseName(old)]);
    expect(report.vaults).toEqual([databaseName(current)]);
    expect(await names()).toEqual([databaseName(current)]);
    expect(await stored(current)).toEqual(config());
  });

  it('skips a replaced database whose Web Lock another app window holds (D154)', async () => {
    const old = await vault(config());
    const current = await vault(config(old));
    const held = await acquireVaultLock(old);
    const report = await run();
    expect(report.deleted).toEqual([]);
    expect(report.skipped).toEqual([databaseName(old)]);
    expect(await stored(current)).toEqual(config(old));
    await held?.release();
    // The next startup finishes the replacement.
    expect((await run()).deleted).toEqual([databaseName(old)]);
    expect(await stored(current)).toEqual(config());
  });

  it('clears a reference to a database already gone, or deleted as uncommitted', async () => {
    const gone = await vault(config(randomId()));
    const uncommitted = await vault();
    const current = await vault(config(uncommitted));
    const report = await run();
    expect(report.deleted).toEqual([databaseName(uncommitted)]);
    expect(await stored(gone)).toEqual(config());
    expect(await stored(current)).toEqual(config());
  });

  it('keeps a reference to a database with an unknown schema', async () => {
    const newerId = randomId();
    const newer = await openDatabase(factory, databaseName(newerId), [
      ...MIGRATIONS,
      () => undefined,
    ]);
    newer.close();
    const current = await vault(config(newerId));
    const report = await run();
    expect(report.deleted).toEqual([]);
    expect(report.skipped).toEqual([databaseName(newerId)]);
    expect(await stored(current)).toEqual(config(newerId));
  });

  it('ignores a Local Config it cannot read, or one that names itself', async () => {
    const unreadable = await vault(new Uint8Array([0xff]));
    const selfId = randomId();
    await vault(config(selfId), selfId);
    const short = await vault(config(new Uint8Array(3)));
    const report = await run();
    expect(report.deleted).toEqual([]);
    expect(report.vaults).toHaveLength(3);
    expect(await stored(unreadable)).toEqual(new Uint8Array([0xff]));
    expect(await stored(selfId)).toEqual(config(selfId));
    expect(await stored(short)).toEqual(config(new Uint8Array(3)));
  });

  it('resolves two databases replacing each other by deleting one of them', async () => {
    const a = randomId();
    const b = randomId();
    await vault(config(b), a);
    await vault(config(a), b);
    const report = await run();
    expect(report.deleted).toHaveLength(1);
    expect(report.vaults).toHaveLength(1);
    expect(await names()).toHaveLength(1);
  });
});
