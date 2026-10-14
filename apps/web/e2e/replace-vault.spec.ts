import { readFile } from 'node:fs/promises';

import { type Browser, type BrowserContext, type Page, expect, test } from '@playwright/test';

import { createVault, openVault } from './create';

// Creation, export and replacement each derive Argon2id at about 1 s (D9).
test.setTimeout(300_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';
const NEW_PASSWORD = 'meadow-copper-signal-anchor-3071';
const SECRET = 'Tulip-Orbit-5528-Granite';

const contexts: BrowserContext[] = [];

test.afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
});

function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

/** A new installation: a browser context of its own, so its storage and Web Locks are its own. */
async function installation(browser: Browser, logged: string[]): Promise<Page> {
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  page.on('console', (message) => logged.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => logged.push(`pageerror: ${String(error.stack ?? error)}`));
  await page.goto('/');
  return page;
}

async function newItem(page: Page, title: string) {
  await button(page, 'New item').click();
  await button(page, 'Login').click();
  await page.getByTestId('item-title').fill(title);
  await page.getByTestId('input-Password').fill(SECRET);
  await button(page, 'Save').click();
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
}

/** Exports from Settings with the local password and returns the file the browser received. */
async function exportBackup(page: Page): Promise<Buffer> {
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByTestId('backup-password').fill(PASSWORD);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    button(page, 'Export').click(),
  ]);
  const bytes = await readFile(await download.path());
  await button(page, 'Back').click();
  return bytes;
}

/** Names of the vault databases this installation holds. */
function databases(page: Page): Promise<string[]> {
  return page.evaluate(async () =>
    (await indexedDB.databases())
      .map((d) => d.name ?? '')
      .filter((n) => n.startsWith('blindvault-'))
      .sort(),
  );
}

/** From the unlock screen: the warning, the file, the phrase, the new password, the confirmation. */
async function replaceWith(page: Page, file: Buffer, words: readonly string[]) {
  await button(page, 'Replace with a backup…').click();
  await expect(page.getByTestId('replace-warning')).toContainText(
    'Changes that exist only on this device are lost.',
  );
  await page.getByTestId('restore-file').setInputFiles({
    name: 'blindvault-backup.bvault',
    mimeType: 'application/octet-stream',
    buffer: file,
  });
  await page.getByTestId('restore-phrase').fill(words.join(' '));
  await button(page, 'Open the backup').click();
  await page.getByTestId('new-password').fill(NEW_PASSWORD, { timeout: 30_000 });
  await page.getByTestId('confirm-password').fill(NEW_PASSWORD);
  // Nothing is replaced without the explicit confirmation (D183).
  await expect(button(page, 'Replace')).toBeDisabled();
  await page.getByTestId('replace-understood').check();
  await button(page, 'Replace').click();
  await openVault(page);
}

test('replaces the locked vault with a backup of another vault, deleting the old database (D89, D183)', async ({
  browser,
}) => {
  const logged: string[] = [];
  const other = await installation(browser, logged);
  const otherWords = await createVault(other, PASSWORD);
  await newItem(other, 'Other');
  const file = await exportBackup(other);

  const page = await installation(browser, logged);
  await createVault(page, PASSWORD);
  await newItem(page, 'Held');
  const [held] = await databases(page);
  await button(page, 'Lock').click();
  await replaceWith(page, file, otherWords);

  await expect(button(page, 'Other')).toBeVisible();
  await expect(button(page, 'Held')).toHaveCount(0);
  const after = await databases(page);
  expect(after).toHaveLength(1);
  expect(after).not.toContain(held);

  await page.reload();
  await page.getByTestId('unlock-password').fill(NEW_PASSWORD);
  await button(page, 'Unlock').click();
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });
  await expect(button(page, 'Other')).toBeVisible();

  const secrets = [PASSWORD, NEW_PASSWORD, SECRET, ...otherWords];
  expect(logged.filter((line) => secrets.some((s) => line.includes(s)))).toEqual([]);
  expect(logged).toEqual([]);
});

test('replaces a vault whose local password is forgotten with its own backup (D153)', async ({
  browser,
}) => {
  const logged: string[] = [];
  const page = await installation(browser, logged);
  const words = await createVault(page, PASSWORD);
  await newItem(page, 'Backed up');
  const file = await exportBackup(page);
  await newItem(page, 'Only here');
  const before = await databases(page);
  await button(page, 'Lock').click();
  await replaceWith(page, file, words);

  await expect(button(page, 'Backed up')).toBeVisible();
  await expect(button(page, 'Only here')).toHaveCount(0);
  // The same vault, replaced in its own database.
  expect(await databases(page)).toEqual(before);

  await button(page, 'Lock').click();
  await page.getByTestId('unlock-password').fill(PASSWORD);
  await button(page, 'Unlock').click();
  await expect(page.getByText('Wrong password.')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('unlock-password').fill(NEW_PASSWORD);
  await button(page, 'Unlock').click();
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });

  const secrets = [PASSWORD, NEW_PASSWORD, SECRET, ...words];
  expect(logged.filter((line) => secrets.some((s) => line.includes(s)))).toEqual([]);
  expect(logged).toEqual([]);
});
