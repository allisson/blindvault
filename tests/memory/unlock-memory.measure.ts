// D277: the memory and time an unlock takes, measured on synthetic vaults of 1,000, 5,000 and
// 10,000 login items with 20 Item Versions each: the time until the vault is usable, the time until
// its Item Versions are verified, and the heap and buffers held once they are. Not part of
// `pnpm test`: run `pnpm --filter @blindvault/tests measure:memory`.

import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import {
  Keyring,
  MEMLIMIT,
  type SymmetricKey,
  derivePrfKek,
  generateRecoveryPhrase,
  initCrypto,
} from '@blindvault/crypto';
import {
  type ItemInput,
  type RecordStore,
  type StoredRecord,
  VaultSession,
  parseLocalConfig,
} from '@blindvault/vault';
import { expect, it } from 'vitest';

const SIZES = [1_000, 5_000, 10_000];
const VERSIONS = 20;
const T0 = 1_760_000_000_000;
const now = () => T0;

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

function kek(keyring: Keyring): SymmetricKey {
  const authenticatorData = new Uint8Array(37);
  authenticatorData[32] = 0x05;
  return derivePrfKek(keyring, { authenticatorData, prfOutput: new Uint8Array(32).fill(1) });
}

function login(i: number, edit: number): ItemInput {
  return {
    templateId: 'login',
    templateVersion: 1,
    title: `Account ${String(i)} at example${String(i)}.com`,
    fields: [
      { type: 'text', role: 'username', value: `user${String(i)}@example.com` },
      { type: 'secret', role: 'password', value: `pw-${String(i)}-${String(edit)}-Xk9!qL2#vB7` },
      { type: 'url', role: 'url', value: `https://example${String(i)}.com/login` },
    ],
    tags: ['synthetic', 'work'],
    notes: `Security questions: first pet, birth city. Recovery codes kept offline. Item ${String(i)}.`,
  };
}

function key(r: { recordType: number; recordId: Uint8Array }): string {
  return `${String(r.recordType)}:${Buffer.from(r.recordId).toString('hex')}`;
}

class Store implements RecordStore {
  readonly held = new Map<string, StoredRecord>();
  localConfig: Uint8Array = new Uint8Array(0);

  record(k: { recordType: number; recordId: Uint8Array }): Promise<StoredRecord | undefined> {
    return Promise.resolve(this.held.get(key(k)));
  }

  records(): Promise<readonly StoredRecord[]> {
    return Promise.resolve([...this.held.values()]);
  }

  commit(commit: Parameters<RecordStore['commit']>[0]): Promise<void> {
    for (const d of commit.delete) this.held.delete(key(d));
    for (const p of commit.put) this.held.set(key(p), p);
    this.localConfig = commit.localConfig;
    return Promise.resolve();
  }

  // The benchmark holds no attachment.
  blobIds(): Promise<readonly Uint8Array[]> {
    return Promise.resolve([]);
  }

  deleteBlobs(): Promise<void> {
    return Promise.resolve();
  }

  blob(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  putBlob(): Promise<void> {
    return Promise.resolve();
  }
}

interface Sample {
  readonly usableMs: number;
  readonly verifiedMs: number;
  readonly heapMiB: number;
  readonly buffersMiB: number;
}

const MiB = 1024 * 1024;

async function measure(store: Store): Promise<Sample> {
  gc();
  const before = process.memoryUsage();
  const keyring = new Keyring();
  const start = performance.now();
  const session = await VaultSession.unlock({
    store,
    localConfig: parseLocalConfig(store.localConfig),
    keyring,
    kek: kek(keyring),
    method: 'password',
    now,
  });
  const usableMs = performance.now() - start;
  expect(session.items().length).toBeGreaterThan(0);
  await session.verified;
  const verifiedMs = performance.now() - start;
  expect(session.corrupt()).toEqual([]);
  gc();
  const after = process.memoryUsage();
  session.lock();
  return {
    usableMs,
    verifiedMs,
    heapMiB: (after.heapUsed - before.heapUsed) / MiB,
    buffersMiB: (after.arrayBuffers - before.arrayBuffers) / MiB,
  };
}

it('measures unlock memory per vault size (D277)', { timeout: 0 }, async () => {
  await initCrypto();
  const store = new Store();
  const keyring = new Keyring();
  const writer = await VaultSession.create({
    store,
    keyring,
    kek: kek(keyring),
    recoveryEntropy: generateRecoveryPhrase(keyring).entropy,
    salt: new Uint8Array(16).fill(7),
    kdfParams: { opslimit: 2, memlimit: MEMLIMIT },
    displayName: 'Benchmark',
    now,
  });
  const rows: string[] = [
    '| Items | Records | Stored MiB | Usable ms | Verified ms | Heap MiB | Buffers MiB |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  let count = 0;
  for (const size of SIZES) {
    for (; count < size; count++) {
      const id = await writer.createItem(login(count, 0));
      for (let edit = 1; edit <= VERSIONS; edit++) await writer.updateItem(id, login(count, edit));
    }
    expect((await writer.versions(writer.items()[0]?.id ?? new Uint8Array())).length).toBe(
      VERSIONS,
    );
    const stored = [...store.held.values()].reduce((n, r) => n + r.envelope.length, 0) / MiB;
    const m = await measure(store);
    const f = (n: number) => n.toFixed(1);
    rows.push(
      `| ${String(size)} | ${String(store.held.size)} | ${f(stored)} | ${f(m.usableMs)} | ${f(m.verifiedMs)} | ${f(m.heapMiB)} | ${f(m.buffersMiB)} |`,
    );
    console.log(rows.at(-1));
  }
  writer.lock();
  console.log(`\n${rows.join('\n')}\n`);
});
