// Builds a vault in Node through the public API, for the load test (architecture.md "Load at
// unlock"): 2,000 items, each edited until it holds HISTORY_LIMIT Item Versions. The Device KEK
// comes from the Argon2id worker entry of @blindvault/crypto, run in-process, so the local password
// opens the vault in a browser.

import {
  type KdfParams,
  type KdfPort,
  type KdfResponse,
  Keyring,
  deriveDeviceKek,
  generateSalt,
  initCrypto,
  normalizePassword,
} from '@blindvault/crypto';
import { databaseName } from '@blindvault/storage';
import {
  HISTORY_LIMIT,
  type ItemInput,
  type RecordStore,
  type StoredRecord,
  VaultSession,
  parseLocalConfig,
} from '@blindvault/vault';

export interface Fixture {
  readonly name: string;
  readonly localConfig: Uint8Array;
  readonly records: readonly StoredRecord[];
}

let worker: Promise<(request: unknown) => Promise<KdfResponse>> | undefined;

/** The worker entry, loaded once with a stand-in `self`: one request at a time. */
function kdfWorker(): Promise<(request: unknown) => Promise<KdfResponse>> {
  worker ??= (async () => {
    let answer: ((response: KdfResponse) => void) | undefined;
    const scope = {
      onmessage: null as ((event: { readonly data: unknown }) => void) | null,
      postMessage(message: unknown) {
        answer?.(message as KdfResponse);
      },
    };
    (globalThis as { self?: unknown }).self = scope;
    await import('@blindvault/crypto/kdf.worker');
    return (request: unknown) =>
      new Promise<KdfResponse>((resolve) => {
        answer = resolve;
        scope.onmessage?.({ data: request });
      });
  })();
  return worker;
}

async function port(): Promise<KdfPort> {
  const run = await kdfWorker();
  const p: KdfPort = {
    onmessage: null,
    onerror: null,
    postMessage(message) {
      void run(message).then((data) => p.onmessage?.({ data }));
    },
    terminate() {
      // in-process: nothing to stop
    },
  };
  return p;
}

function item(i: number, edit: number): ItemInput {
  return {
    templateId: 'login',
    templateVersion: 1,
    title: `Account ${String(i).padStart(4, '0')}`,
    fields: [
      { type: 'text', role: 'username', value: `user${String(i)}@example.com` },
      { type: 'secret', role: 'password', value: `Pw-${String(i)}-${String(edit)}-Lantern-Orbit` },
      { type: 'url', role: 'url', value: `https://site${String(i)}.example/login` },
    ],
    tags: ['load'],
    notes: `Edit ${String(edit)} of item ${String(i)}. `.repeat(4).trim(),
  };
}

/** A vault of `items` items with `edits` edits each, opened by `password` at `params`. */
export async function buildVault(
  password: string,
  params: KdfParams,
  items: number,
  edits: number = HISTORY_LIMIT,
): Promise<Fixture> {
  await initCrypto();
  const held = new Map<string, StoredRecord>();
  let localConfig = new Uint8Array(0);
  const key = (r: { recordType: number; recordId: Uint8Array }) =>
    `${String(r.recordType)}:${Buffer.from(r.recordId).toString('hex')}`;
  const store: RecordStore = {
    records: () => Promise.resolve([...held.values()]),
    commit: (commit) => {
      for (const d of commit.delete) held.delete(key(d));
      for (const p of commit.put) held.set(key(p), p);
      localConfig = commit.localConfig.slice();
      return Promise.resolve();
    },
  };
  const keyring = new Keyring();
  const salt = generateSalt();
  const kek = await deriveDeviceKek(
    keyring,
    await port(),
    normalizePassword(password),
    salt,
    params,
  );
  const session = await VaultSession.create({
    store,
    keyring,
    kek,
    salt,
    kdfParams: params,
    displayName: 'Load test',
  });
  try {
    for (let i = 0; i < items; i++) {
      const id = await session.createItem(item(i, 0));
      for (let e = 1; e <= edits; e++) await session.updateItem(id, item(i, e));
    }
  } finally {
    session.lock();
  }
  return {
    name: databaseName(parseLocalConfig(localConfig).vaultId),
    localConfig,
    records: [...held.values()],
  };
}

/** Milliseconds `VaultSession.unlock` takes over `fixture` held in memory, Argon2id excluded. */
export async function unlockInMemory(fixture: Fixture, password: string): Promise<number> {
  const localConfig = parseLocalConfig(fixture.localConfig);
  const keyring = new Keyring();
  const { salt, opslimit, memlimit } = localConfig.kek;
  const kek = await deriveDeviceKek(keyring, await port(), normalizePassword(password), salt, {
    opslimit,
    memlimit,
  });
  const store: RecordStore = {
    records: () => Promise.resolve(fixture.records),
    commit: () => Promise.reject(new Error('read only')),
  };
  const start = performance.now();
  const session = await VaultSession.unlock({
    store,
    localConfig,
    keyring,
    kek,
    method: 'password',
  });
  const elapsed = performance.now() - start;
  session.lock();
  return Math.round(elapsed);
}
