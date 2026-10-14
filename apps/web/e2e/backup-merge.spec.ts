import { readFile } from 'node:fs/promises';

import { type Browser, type BrowserContext, type Page, expect, test } from '@playwright/test';

import { createVault, openVault, startScreen } from './create';

// Creation, export, restore and merge each derive Argon2id at about 1 s (D9).
test.setTimeout(300_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';
const B_PASSWORD = 'meadow-copper-signal-anchor-3071';
const FIRST = 'Tulip-Orbit-5528-Granite';
const ON_A = 'Cedar-Pixel-7710-Ferry';
const ON_B = 'Lumen-Basalt-3346-Wren';

const contexts: BrowserContext[] = [];

test.afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
});

function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

function watchLogs(page: Page, logged: string[]): void {
  page.on('console', (message) => logged.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => logged.push(`pageerror: ${String(error.stack ?? error)}`));
}

/** A new installation: a browser context of its own, so its storage and Web Locks are its own. */
async function installation(browser: Browser, logged: string[]): Promise<Page> {
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  watchLogs(page, logged);
  await page.goto('/');
  return page;
}

async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings' }).first().click();
}

/** Exports from Settings with the local password and returns the file the browser received. */
async function exportBackup(page: Page, password: string): Promise<Buffer> {
  await openSettings(page);
  await page.getByTestId('backup-password').fill(password);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    button(page, 'Export').click(),
  ]);
  const bytes = await readFile(await download.path());
  await button(page, 'Back').click();
  return bytes;
}

async function setPassword(page: Page, value: string) {
  await button(page, 'ACME').click();
  await button(page, 'Edit').click();
  await page.getByTestId('input-Password').fill(value);
  await button(page, 'Save').click();
  await expect(page.getByRole('heading', { name: 'ACME', level: 1 })).toBeVisible();
}

/** Settings › Merge a backup: the file, the Recovery Phrase, then the confirmation. */
async function openForMerge(page: Page, file: Buffer, words: readonly string[]) {
  await openSettings(page);
  await page.getByTestId('merge-start').click();
  await page.getByTestId('restore-file').setInputFiles({
    name: 'blindvault-backup.bvault',
    mimeType: 'application/octet-stream',
    buffer: file,
  });
  await page.getByTestId('restore-phrase').fill(words.join(' '));
  await button(page, 'Open the backup').click();
}

test('merges a backup made on another installation, keeping the losing edit in history (Gate B, D182)', async ({
  browser,
}) => {
  const logged: string[] = [];
  const a = await installation(browser, logged);
  const words = await createVault(a, PASSWORD);
  await button(a, 'New item').click();
  await button(a, 'Login').click();
  await a.getByTestId('item-title').fill('ACME');
  await a.getByTestId('input-Password').fill(FIRST);
  await button(a, 'Save').click();
  const first = await exportBackup(a, PASSWORD);

  // Installation B: the same vault, by a fresh restore of A's backup.
  const b = await installation(browser, logged);
  await startScreen(b);
  await button(b, 'Restore from a backup').click();
  await b.getByTestId('restore-file').setInputFiles({
    name: 'blindvault-backup.bvault',
    mimeType: 'application/octet-stream',
    buffer: first,
  });
  await b.getByTestId('restore-phrase').fill(words.join(' '));
  await button(b, 'Open the backup').click();
  await b.getByTestId('new-password').fill(B_PASSWORD);
  await b.getByTestId('confirm-password').fill(B_PASSWORD);
  await button(b, 'Restore').click();
  await openVault(b);

  // Concurrent edits: A first, then B, so B's is the newer write.
  await setPassword(a, ON_A);
  await setPassword(b, ON_B);
  const fromB = await exportBackup(b, B_PASSWORD);

  await openForMerge(a, fromB, words);
  await expect(a.getByTestId('merge-confirm')).toContainText('verified.', { timeout: 30_000 });
  await button(a, 'Merge').click();
  await expect(a.getByTestId('merge-result')).toContainText('Merged: 0 added, 1 replaced.');

  // B's edit won; A's own edit is in the history, above the first state.
  await button(a, 'Back').click();
  await button(a, 'ACME').click();
  await button(a, 'Show').click();
  await expect(a.getByTestId('secret-Password')).toHaveText(ON_B);
  await button(a, 'History').click();
  const versions = a.locator('article').getByRole('listitem');
  await expect(versions).toHaveCount(2);
  await versions.first().getByRole('button', { name: 'Show', exact: true }).click();
  await expect(versions.first()).toContainText(ON_A);

  const secrets = [PASSWORD, B_PASSWORD, FIRST, ON_A, ON_B, ...words];
  expect(logged.filter((line) => secrets.some((s) => line.includes(s)))).toEqual([]);
  expect(logged).toEqual([]);
});

test('refuses to merge a backup of another vault, before asking to confirm (D13)', async ({
  browser,
}) => {
  const logged: string[] = [];
  const other = await installation(browser, logged);
  const otherWords = await createVault(other, PASSWORD);
  const file = await exportBackup(other, PASSWORD);

  const a = await installation(browser, logged);
  await createVault(a, PASSWORD);
  await openForMerge(a, file, otherWords);
  await expect(
    a.getByText('This backup is of another vault. It cannot be merged into this one.'),
  ).toBeVisible({ timeout: 30_000 });
  await expect(a.getByTestId('merge-confirm')).toHaveCount(0);
  expect(logged).toEqual([]);
});
