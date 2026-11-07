import { type Page, expect, test } from '@playwright/test';

import { MEMLIMIT } from '@blindvault/crypto';
import { HISTORY_LIMIT } from '@blindvault/vault';

import { type Fixture, buildVault, install, unlockInMemory } from './load-fixture';

// The load test of architecture.md ("Load at unlock"): opt-in, since building and writing 42,000
// records takes minutes. Run it with `BV_LOAD_TEST=1 pnpm exec playwright test e2e/load.spec.ts`.
test.skip(!process.env.BV_LOAD_TEST, 'set BV_LOAD_TEST=1 to run the load test');
test.setTimeout(15 * 60_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';
const ITEMS = 2000;
// Fixed, so both vaults derive alike; within the accepted range (D9).
const PARAMS = { opslimit: 3, memlimit: MEMLIMIT };

let empty: Fixture;
let loaded: Fixture;

test.beforeAll(async () => {
  empty = await buildVault(PASSWORD, PARAMS, 0);
  loaded = await buildVault(PASSWORD, PARAMS, ITEMS);
  // Vault Key, Device record, then each item and its versions.
  expect(loaded.records).toHaveLength(2 + ITEMS * (1 + HISTORY_LIMIT));
  // The same unlock in Node, records in memory: decryption and parsing without IndexedDB.
  console.log(`[load] node, in memory: ${String(await unlockInMemory(loaded, PASSWORD))} ms`);
});

/** Milliseconds from the Unlock click to the unlocked vault. */
async function timedUnlock(page: Page): Promise<number> {
  await page.reload();
  await page.getByTestId('unlock-password').fill(PASSWORD);
  const start = Date.now();
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 10 * 60_000 });
  return Date.now() - start;
}

test('unlocks 2,000 items × 20 versions (architecture.md)', async ({ page, browserName }) => {
  await page.goto('/');
  await install(page, empty);
  const baseline = await timedUnlock(page);
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await page.evaluate((name) => indexedDB.deleteDatabase(name), empty.name);

  await page.goto('/');
  await install(page, loaded);
  const idb = await page.evaluate(async (name) => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open(name);
      r.onsuccess = () => {
        resolve(r.result);
      };
    });
    const t = performance.now();
    const tx = db.transaction('records');
    const keys = tx.objectStore('records').getAllKeys();
    const values = tx.objectStore('records').getAll();
    await new Promise((resolve) => (tx.oncomplete = resolve));
    const ms = performance.now() - t;
    db.close();
    return { ms: Math.round(ms), n: keys.result.length + values.result.length };
  }, loaded.name);
  console.log(`[load] ${browserName}: IndexedDB getAll ${String(idb.ms)} ms (${String(idb.n)})`);
  const full = await timedUnlock(page);
  await expect(page.getByRole('button', { name: 'Account 0000', exact: true })).toBeVisible();
  console.log(
    `[load] ${browserName}: empty vault ${String(baseline)} ms, ${String(loaded.records.length)} records ${String(full)} ms, load ≈ ${String(full - baseline)} ms`,
  );
});
