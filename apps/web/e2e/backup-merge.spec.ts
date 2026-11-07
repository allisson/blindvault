import { readFile } from 'node:fs/promises';

import { type Browser, type BrowserContext, type Page, expect, test } from '@playwright/test';

import { createVault, openVault, startScreen } from './create';
import { PAIRING_URL } from '../playwright.config';
import { fillPassword } from './password';

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
  // After a merge, Settings still shows it, with no Settings button of its own.
  if (!(await page.getByTestId('merge-start').isVisible())) await openSettings(page);
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

test.describe('devices a merge brings', () => {
  // Pairing copies and pastes with no camera: WebKit on Linux does not connect (D203), and Firefox
  // gathers no ICE candidate on `localhost` (playwright.config.ts).
  test.beforeEach(({ browserName }) => {
    test.skip(
      browserName === 'webkit' && process.platform === 'linux',
      'WebKit on Linux does not connect over mDNS names only',
    );
  });
  test.use({ baseURL: PAIRING_URL });

  /** A pairs a new installation, same network only; A ends back in its vault. */
  async function pair(browser: Browser, a: Page, logged: string[]) {
    await openSettings(a);
    await button(a, 'Pair a device…').click();
    await a.getByTestId('pairing-same-network').check();
    await fillPassword(a.getByTestId('invite-password'), PASSWORD);
    await button(a, 'Start pairing').click();
    const offer = a.getByTestId('pairing-text');
    await expect(offer).not.toHaveValue('', { timeout: 30_000 });

    const b = await installation(browser, logged);
    await startScreen(b);
    await button(b, 'Pair with an existing device').click();
    await fillPassword(b.getByTestId('new-password'), B_PASSWORD);
    await fillPassword(b.getByTestId('confirm-password'), B_PASSWORD);
    await b.getByTestId('pairing-same-network').check();
    await button(b, 'Start pairing').click();
    await b.getByTestId('pairing-paste').fill(await offer.inputValue(), { timeout: 30_000 });
    await button(b, 'Show my answer').click();
    const answer = b.getByTestId('pairing-text');
    await expect(answer).not.toHaveValue('', { timeout: 30_000 });
    await a.getByTestId('pairing-paste').fill(await answer.inputValue());
    await button(a, 'Connect').click();
    await expect(a.getByTestId('pairing-sas')).toBeVisible({ timeout: 30_000 });
    await button(a, 'Yes, the same').click();
    await button(b, 'Yes, the same').click();
    await expect(a.getByTestId('pairing-done')).toBeVisible({ timeout: 60_000 });
    await button(a, 'Close').click();
    await button(a, 'Back').click();
  }

  test('a merge names a device this one never saw, then one retired elsewhere, as a sign of the Master Key held by someone else (§1.6, D182)', async ({
    browser,
  }) => {
    const logged: string[] = [];
    const a = await installation(browser, logged);
    const words = await createVault(a, PASSWORD);
    const before = await exportBackup(a, PASSWORD);
    await pair(browser, a, logged);
    const paired = await exportBackup(a, PASSWORD);

    // C: a fresh restore of the backup made before the pairing, so it knows only A.
    const c = await installation(browser, logged);
    await startScreen(c);
    await button(c, 'Restore from a backup').click();
    await c.getByTestId('restore-file').setInputFiles({
      name: 'blindvault-backup.bvault',
      mimeType: 'application/octet-stream',
      buffer: before,
    });
    await c.getByTestId('restore-phrase').fill(words.join(' '));
    await button(c, 'Open the backup').click();
    await c.getByTestId('new-password').fill(B_PASSWORD);
    await c.getByTestId('confirm-password').fill(B_PASSWORD);
    await button(c, 'Restore').click();
    await openVault(c);

    await openForMerge(c, paired, words);
    await button(c, 'Merge').click();
    const result = c.getByTestId('merge-result');
    await expect(result).toContainText('Devices this device had never seen: ', { timeout: 30_000 });
    await expect(result).toContainText(
      'A device you did not pair means someone holding the Master Key added it.',
    );
    await expect(result).not.toContainText('Devices now retired');

    // A retires the paired device; its next backup tells C.
    await openSettings(a);
    await a.getByTestId('device-retire').click();
    await a.getByRole('button', { name: /^Retire / }).click();
    await expect(a.getByTestId('device')).toHaveCount(1);
    await button(a, 'Back').click();
    const retired = await exportBackup(a, PASSWORD);

    await openForMerge(c, retired, words);
    await button(c, 'Merge').click();
    await expect(result).toContainText('Devices now retired: ', { timeout: 30_000 });
    await expect(result).toContainText(
      'If you did not retire them, someone holding the Master Key did.',
    );
    await expect(result).not.toContainText('had never seen');
    expect(logged).toEqual([]);
  });
});
