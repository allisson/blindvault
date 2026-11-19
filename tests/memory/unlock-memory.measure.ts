// D277: the memory and time an unlock takes, measured on synthetic vaults of 1,000, 5,000 and
// 10,000 login items with 20 Item Versions each. Each size is unlocked twice: with every record,
// then without the Item Versions, so the table shows what the versions alone hold. Not part of
// `pnpm test`: run `pnpm --filter @blindvault/tests measure:memory`.

import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import {
  Keyring,
  MEMLIMIT,
  RecordType,
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

/** An in-memory store; `withoutVersions` hands unlock every record but the Item Versions. */
class Store implements RecordStore {
  readonly held = new Map<string, StoredRecord>();
  localConfig: Uint8Array = new Uint8Array(0);
  withoutVersions = false;

  records(): Promise<readonly StoredRecord[]> {
    const all = [...this.held.values()];
    return Promise.resolve(
      this.withoutVersions ? all.filter((r) => r.recordType !== RecordType.itemVersion) : all,
    );
  }

  commit(commit: Parameters<RecordStore['commit']>[0]): Promise<void> {
    const key = (r: { recordType: number; recordId: Uint8Array }) =>
      `${String(r.recordType)}:${Buffer.from(r.recordId).toString('hex')}`;
    for (const d of commit.delete) this.held.delete(key(d));
    for (const p of commit.put) this.held.set(key(p), p);
    this.localConfig = commit.localConfig;
    return Promise.resolve();
  }
}

interface Sample {
  readonly heapMiB: number;
  readonly buffersMiB: number;
  readonly ms: number;
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
  const ms = performance.now() - start;
  gc();
  const after = process.memoryUsage();
  expect(session.items().length).toBeGreaterThan(0);
  session.lock();
  return {
    heapMiB: (after.heapUsed - before.heapUsed) / MiB,
    buffersMiB: (after.arrayBuffers - before.arrayBuffers) / MiB,
    ms,
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
    '| Items | Records | Stored MiB | Heap MiB | Buffers MiB | Unlock ms | Heap MiB, no versions | Buffers MiB, no versions | Unlock ms, no versions |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  let count = 0;
  for (const size of SIZES) {
    for (; count < size; count++) {
      const id = await writer.createItem(login(count, 0));
      for (let edit = 1; edit <= VERSIONS; edit++) await writer.updateItem(id, login(count, edit));
    }
    expect(writer.versions(writer.items()[0]?.id ?? new Uint8Array()).length).toBe(VERSIONS);
    const stored = [...store.held.values()].reduce((n, r) => n + r.envelope.length, 0) / MiB;
    store.withoutVersions = false;
    const full = await measure(store);
    store.withoutVersions = true;
    const items = await measure(store);
    store.withoutVersions = false;
    const f = (n: number) => n.toFixed(1);
    rows.push(
      `| ${String(size)} | ${String(store.held.size)} | ${f(stored)} | ${f(full.heapMiB)} | ${f(full.buffersMiB)} | ${f(full.ms)} | ${f(items.heapMiB)} | ${f(items.buffersMiB)} | ${f(items.ms)} |`,
    );
    console.log(rows.at(-1));
  }
  writer.lock();
  console.log(`\n${rows.join('\n')}\n`);
});
