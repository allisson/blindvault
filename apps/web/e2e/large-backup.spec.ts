import { writeFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { parseBackup, restoreWithPassword } from '@blindvault/backup';
import { Keyring, MEMLIMIT, normalizePassword } from '@blindvault/crypto';
import { HISTORY_LIMIT } from '@blindvault/vault';

import { buildBackup, workerPort } from './load-fixture';

// Not a test: writes the load test's vault as a `.bvault` file for the Gate C manual run, which
// restores it on the device that holds the vault and measures its pairing with a phone (D202).
// Opt-in, since building 42,000 records takes minutes:
//   BV_LARGE_BACKUP=/path/large.bvault BV_EXPORT_PASSWORD='…' \
//     pnpm --filter @blindvault/web exec playwright test e2e/large-backup.spec.ts --project=chromium
// The file opens with the export password; its Recovery Phrase is discarded.
const out = process.env.BV_LARGE_BACKUP;
const exportPassword = process.env.BV_EXPORT_PASSWORD;
test.skip(!out || !exportPassword, 'set BV_LARGE_BACKUP and BV_EXPORT_PASSWORD to write the file');
test.setTimeout(15 * 60_000);

const ITEMS = 2000;
const PARAMS = { opslimit: 3, memlimit: MEMLIMIT };

test('writes the load vault as a .bvault file that its export password opens', async () => {
  if (!out || !exportPassword) return;
  // The local password of the built vault: the restore asks for a new one.
  const bytes = await buildBackup(
    'quartz-lantern-velvet-harbor-9214',
    exportPassword,
    PARAMS,
    ITEMS,
  );
  const keyring = new Keyring();
  const restored = await restoreWithPassword(
    keyring,
    await workerPort(),
    parseBackup(bytes),
    normalizePassword(exportPassword),
  );
  keyring.wipeAll();
  expect(restored.records.length).toBeGreaterThan(ITEMS * (1 + HISTORY_LIMIT));
  writeFileSync(out, bytes);
  console.log(
    `[large-backup] ${String(restored.records.length)} records, ${String(bytes.length)} bytes: ${out}`,
  );
});
