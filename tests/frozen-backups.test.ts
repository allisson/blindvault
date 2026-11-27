// Backups exported by published builds, frozen (backup-format.md §9, D310, review RC-01): each file
// in tests/fixtures/backups restores with its Recovery Phrase and with its export password, onto an
// empty installation, to the vault its manifest summarizes. The vectors of backup-v1.json and
// backup-v2.json are rewritten by the generator and follow the current spec; these files never
// change, so a change made at once to the spec, the generator and the code cannot pass by them.

import { readFileSync, readdirSync } from 'node:fs';

import {
  type ValidatedBackup,
  parseBackup,
  restoreWithPassword,
  restoreWithPhrase,
} from '@blindvault/backup';
import {
  type KdfPort,
  Keyring,
  MEMLIMIT,
  derivePrfKek,
  handleKdfRequest,
  initCrypto,
  normalizePassword,
} from '@blindvault/crypto';
import { VaultDatabase } from '@blindvault/storage';
import { VaultSession } from '@blindvault/vault';
import { IDBFactory } from 'fake-indexeddb';
import { beforeAll, describe, expect, it } from 'vitest';

const DIR = new URL('./fixtures/backups/', import.meta.url);

interface Manifest {
  readonly build: string;
  readonly phrase: string;
  readonly exportPassword: string;
  readonly summary?: unknown;
}

const fixtures = readdirSync(DIR)
  .filter((f) => f.endsWith('.bvault'))
  .map((f) => f.slice(0, -'.bvault'.length))
  .sort();

/** The Argon2id worker, run in this thread: an export password's keyslot holds real parameters. */
function kdf(): KdfPort {
  const port: KdfPort = {
    onmessage: null,
    onerror: null,
    postMessage(message) {
      const data = handleKdfRequest(message, () => performance.now());
      queueMicrotask(() => port.onmessage?.({ data }));
    },
    terminate() {
      // nothing runs in the background
    },
  };
  return port;
}

/**
 * What a vault restored onto an empty installation, through IndexedDB, holds, by what a user sees of
 * it: comparable with a manifest.
 */
async function summary(contents: ValidatedBackup) {
  const keyring = new Keyring();
  const authenticatorData = new Uint8Array(37);
  authenticatorData[32] = 0x05;
  const db = await VaultDatabase.open(contents.vaultId, new IDBFactory());
  const session = await VaultSession.restore({
    store: {
      records: () => db.records(),
      record: (key) => db.record(key),
      blobIds: () => db.blobIds(),
      deleteBlobs: (ids) => db.deleteBlobs(ids),
      blob: (id) => db.blob(id),
      putBlob: (b) => db.putBlob(b),
      commit: (c) => db.commit(c),
    },
    keyring,
    kek: derivePrfKek(keyring, { authenticatorData, prfOutput: new Uint8Array(32).fill(1) }),
    salt: new Uint8Array(16).fill(9),
    kdfParams: { opslimit: 2, memlimit: MEMLIMIT },
    backup: contents,
    now: () => contents.exportedAt,
  });
  try {
    const restored = await session.restoreBlobs(contents);
    const items = await Promise.all(
      session.items().map(async (v) => ({
        title: v.item?.title ?? null,
        templateId: v.item?.templateId ?? null,
        inTrash: v.inTrash,
        fields: (v.item?.fields ?? []).map((f) => f.type),
        versions: (await session.versions(v.id)).length,
      })),
    );
    return {
      items: items.sort((a, b) => String(a.title).localeCompare(String(b.title))),
      folders: session
        .folders()
        .map((f) => f.name)
        .sort(),
      devices: session.devices().length,
      records: contents.records.length,
      blobs: contents.blobIds.length,
      missing: restored.missing.length,
    };
  } finally {
    session.lock();
    db.close();
  }
}

beforeAll(initCrypto);

describe('backups exported by published builds (D310)', () => {
  it('pairs every frozen file with its manifest', () => {
    const manifests = readdirSync(DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort();
    expect(manifests).toEqual(fixtures);
  });

  it.each(fixtures)(
    'restores %s with its phrase and its password, as the manifest says',
    async (name) => {
      const file = new Uint8Array(readFileSync(new URL(`${name}.bvault`, DIR)));
      const manifest = JSON.parse(readFileSync(new URL(`${name}.json`, DIR), 'utf8')) as Manifest;
      expect(manifest.build).toBe(name);
      const byPhrase = await summary(
        await restoreWithPhrase(new Keyring(), await parseBackup(file), manifest.phrase),
      );
      const byPassword = await summary(
        await restoreWithPassword(
          new Keyring(),
          kdf(),
          await parseBackup(file),
          normalizePassword(manifest.exportPassword),
        ),
      );
      expect(byPassword).toEqual(byPhrase);
      if (manifest.summary === undefined) {
        throw new Error(
          `${name}.json has no summary; check this one and add it:\n${JSON.stringify(byPhrase, null, 2)}`,
        );
      }
      expect(byPhrase).toEqual(manifest.summary);
    },
    120_000,
  );
});
