import { readFile } from 'node:fs/promises';

import { type Page, expect, test } from '@playwright/test';

import { createVault } from './create';

// Creation, export and restore each calibrate or derive Argon2id at about 1 s (D9).
test.setTimeout(240_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';
const NEW_PASSWORD = 'meadow-copper-signal-anchor-3071';
const SECRET = 'Tulip-Orbit-5528-Granite';
/** A valid phrase of another vault: all-zero entropy. */
const OTHER_PHRASE = `${'abandon '.repeat(23)}art`;

function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

function watchLogs(page: Page): string[] {
  const logged: string[] = [];
  page.on('console', (message) => logged.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => logged.push(`pageerror: ${String(error.stack ?? error)}`));
  return logged;
}

/** A vault holding one login, as a user makes it. */
async function vaultWithItem(page: Page): Promise<string[]> {
  await page.goto('/');
  const words = await createVault(page, PASSWORD);
  await button(page, 'New item').click();
  await button(page, 'Login').click();
  await page.getByTestId('item-title').fill('ACME');
  await page.getByTestId('input-Password').fill(SECRET);
  await button(page, 'Save').click();
  await page.getByRole('button', { name: 'Settings' }).first().click();
  return words;
}

/** Exports from Settings with the local password and returns the file the browser received. */
async function exportBackup(page: Page): Promise<Buffer> {
  await page.getByTestId('backup-password').fill(PASSWORD);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    button(page, 'Export').click(),
  ]);
  return readFile(await download.path());
}

/** Locks and deletes every database of this origin: the browser lost its storage. */
async function loseStorage(page: Page): Promise<void> {
  await button(page, 'Lock').click();
  await page.evaluate(async () => {
    for (const { name } of await indexedDB.databases()) {
      if (!name) continue;
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => {
          resolve();
        };
        request.onerror = () => {
          reject(new Error('delete failed'));
        };
      });
    }
  });
  await page.goto('/');
  await expect(button(page, 'Restore from a backup')).toBeVisible();
}

async function databases(page: Page): Promise<number> {
  return page.evaluate(async () => (await indexedDB.databases()).length);
}

function file(name: string, buffer: Buffer) {
  return { name, mimeType: 'application/octet-stream', buffer };
}

async function chooseFile(page: Page, buffer: Buffer, name = 'blindvault-backup.bvault') {
  await page.getByTestId('restore-file').setInputFiles(file(name, buffer));
}

async function openWithPhrase(page: Page, phrase: string) {
  await page.getByTestId('restore-phrase').fill(phrase);
  await button(page, 'Open the backup').click();
}

async function setLocalPassword(page: Page, password: string) {
  await page.getByTestId('new-password').fill(password);
  await page.getByTestId('confirm-password').fill(password);
  await button(page, 'Restore').click();
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 60_000 });
}

test('restores a backup by the Recovery Phrase after the browser lost its storage (Gate B, D33, D95)', async ({
  page,
}) => {
  const logged = watchLogs(page);
  const words = await vaultWithItem(page);
  const backup = await exportBackup(page);
  await loseStorage(page);
  await button(page, 'Restore from a backup').click();

  // Not a backup, then a truncated one: a clear error each time (D95).
  await chooseFile(page, Buffer.from('{"items":[]}'), 'export.json');
  await expect(page.getByText('This file is not a BlindVault backup.')).toBeVisible();
  await chooseFile(page, backup.subarray(0, backup.length - 1));
  await expect(page.getByTestId('restore-header')).toContainText(
    'Not verified until the backup opens.',
  );
  await openWithPhrase(page, words.join(' '));
  await expect(
    page.getByText('This backup is damaged or incomplete. It cannot be restored.'),
  ).toBeVisible();

  // The whole file: another vault's phrase says only that it did not open.
  await chooseFile(page, backup);
  await openWithPhrase(page, OTHER_PHRASE);
  await expect(page.getByText('The backup did not open with this Recovery Phrase.')).toBeVisible();
  await expect(page.getByTestId('restore-phrase')).toHaveValue('');
  await openWithPhrase(page, words.join('\n').toUpperCase());
  await expect(page.getByTestId('restore-opened')).toContainText('verified.');
  // Nothing is written before the local password (D33).
  expect(await databases(page)).toBe(0);
  await setLocalPassword(page, NEW_PASSWORD);
  await expect(button(page, 'ACME')).toBeVisible();
  await expect(page.getByTestId('after-restore')).toHaveCount(0);

  // The new local password opens it; the old one does not.
  await button(page, 'Lock').click();
  await page.getByTestId('unlock-password').fill(PASSWORD);
  await button(page, 'Unlock').click();
  await expect(page.getByText('Wrong password.')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('unlock-password').fill(NEW_PASSWORD);
  await button(page, 'Unlock').click();
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });
  await expect(button(page, 'ACME')).toBeVisible();

  const secrets = [PASSWORD, NEW_PASSWORD, SECRET, ...words];
  expect(logged.filter((line) => secrets.some((s) => line.includes(s)))).toEqual([]);
  expect(logged).toEqual([]);
});

test('restores a backup by its export password, then recommends Check Recovery Phrase (D43)', async ({
  page,
}) => {
  const logged = watchLogs(page);
  await vaultWithItem(page);
  await page.getByTestId('backup-protect').check();
  await button(page, 'Generate a passphrase').click();
  const passphrase = await page.getByTestId('export-password').inputValue();
  await page.getByTestId('export-confirm').fill(passphrase);
  const backup = await exportBackup(page);
  await loseStorage(page);
  await button(page, 'Restore from a backup').click();

  await chooseFile(page, backup);
  await page.getByRole('radio', { name: 'Export password' }).check();
  await page.getByTestId('restore-export-password').fill(`${passphrase}x`);
  await button(page, 'Open the backup').click();
  await expect(page.getByText('The backup did not open with this export password.')).toBeVisible({
    timeout: 30_000,
  });
  await page.getByTestId('restore-export-password').fill(passphrase);
  await button(page, 'Open the backup').click();
  await expect(page.getByTestId('restore-opened')).toBeVisible({ timeout: 30_000 });
  await setLocalPassword(page, NEW_PASSWORD);
  await expect(button(page, 'ACME')).toBeVisible();
  await expect(page.getByTestId('after-restore')).toContainText('Recovery Phrase still opens it');
  await button(page, 'Dismiss').click();
  await expect(page.getByTestId('after-restore')).toHaveCount(0);

  const secrets = [PASSWORD, NEW_PASSWORD, SECRET, passphrase];
  expect(logged.filter((line) => secrets.some((s) => line.includes(s)))).toEqual([]);
  expect(logged).toEqual([]);
});
