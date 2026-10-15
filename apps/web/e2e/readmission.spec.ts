import { readFile } from 'node:fs/promises';

import { type Browser, type Page, expect, test } from '@playwright/test';

import { createVault, openVault, startScreen } from './create';
import { PAIRING_URL } from '../playwright.config';
import { fillPassword } from './password';

// A re-admission between two installations of the same vault, each in its own browser context,
// through the screens alone (§9, D206, D207): one shows its text first, the other pastes it and
// answers, the SAS is confirmed on both, then both know each other and hold every record.

// Creation, export and restore each run Argon2id at about 1 s (D9).
test.setTimeout(240_000);

test.beforeEach(({ browserName }) => {
  // Copy/paste with no camera: as for pairing, WebKit on Linux does not connect (D203).
  test.skip(
    browserName === 'webkit' && process.platform === 'linux',
    'WebKit on Linux does not connect over mDNS names only',
  );
});

// Firefox gathers no ICE candidate on `localhost`: this spec runs on 127.0.0.1 (playwright.config.ts).
test.use({ baseURL: PAIRING_URL });

const PASSWORD_A = 'quartz-lantern-velvet-harbor-9214';
const PASSWORD_B = 'meadow-copper-signal-anchor-3071';

function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

function watchLogs(page: Page, logged: string[]): void {
  page.on('console', (message) => logged.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => logged.push(`pageerror: ${String(error.stack ?? error)}`));
}

async function device(browser: Browser, logged: string[]): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  watchLogs(page, logged);
  await page.goto('/');
  return page;
}

async function addItem(page: Page, title: string): Promise<void> {
  await button(page, 'New item').click();
  await button(page, 'Login').click();
  await page.getByTestId('item-title').fill(title);
  await button(page, 'Save').click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

/** Settings › Devices › Re-admission, same network only; `first` shows its text first. */
async function startReadmission(page: Page, first: boolean): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await button(page, 'Re-admit with another device of this vault…').click();
  await page.getByTestId('readmit-device').getByTestId('pairing-same-network').check();
  await page.getByTestId(first ? 'readmission-first' : 'readmission-paste').click();
}

/** `a` shows its text, `b` pastes it and answers, `a` connects: both show the same SAS. */
async function toSas(a: Page, b: Page): Promise<void> {
  await startReadmission(a, true);
  const offer = a.getByTestId('pairing-text');
  await expect(offer).not.toHaveValue('', { timeout: 30_000 });
  await startReadmission(b, false);
  await b.getByTestId('pairing-paste').fill(await offer.inputValue());
  await button(b, 'Continue').click();
  const answer = b.getByTestId('pairing-text');
  await expect(answer).not.toHaveValue('', { timeout: 30_000 });
  await a.getByTestId('pairing-paste').fill(await answer.inputValue());
  await button(a, 'Connect').click();
  const sasA = a.getByTestId('pairing-sas');
  await expect(sasA).toHaveText(/^\d{3} \d{3}$/, { timeout: 30_000 });
  await expect(b.getByTestId('pairing-sas')).toHaveText((await sasA.textContent()) ?? '', {
    timeout: 30_000,
  });
}

test('re-admits a restored device: both know each other and hold every item (§9, D22, D207)', async ({
  browser,
}) => {
  const logged: string[] = [];
  const a = await device(browser, logged);
  const words = await createVault(a, PASSWORD_A);
  await addItem(a, 'Harbor Bank');
  await a.getByRole('button', { name: 'Settings' }).first().click();
  await a.getByTestId('backup-password').fill(PASSWORD_A);
  const [download] = await Promise.all([
    a.waitForEvent('download', { timeout: 60_000 }),
    button(a, 'Export').click(),
  ]);
  const backup = await readFile(await download.path());
  await button(a, 'Back').click();

  // B: a fresh restore of A's backup, unregistered, with an item of its own.
  const b = await device(browser, logged);
  await startScreen(b);
  await button(b, 'Restore from a backup').click();
  await b.getByTestId('restore-file').setInputFiles({
    name: 'blindvault-backup.bvault',
    mimeType: 'application/octet-stream',
    buffer: backup,
  });
  await b.getByTestId('restore-phrase').fill(words.join(' '));
  await button(b, 'Open the backup').click();
  await fillPassword(b.getByTestId('new-password'), PASSWORD_B);
  await fillPassword(b.getByTestId('confirm-password'), PASSWORD_B);
  await button(b, 'Restore').click();
  await openVault(b);
  await addItem(b, 'Copper Mail');

  await toSas(a, b);
  await button(a, 'Yes, the same').click();
  await button(b, 'Yes, the same').click();
  await expect(a.getByTestId('readmission-done')).toContainText('Re-admitted with', {
    timeout: 60_000,
  });
  await expect(b.getByTestId('readmission-done')).toContainText('Re-admitted with', {
    timeout: 60_000,
  });
  await expect(a.getByTestId('merge-result')).toContainText('Merged: ');
  await expect(a.getByTestId('readmission-not-committed')).toHaveCount(0);
  await expect(a.getByTestId('readmission-rejected')).toHaveCount(0);

  // Both devices on both, each synced with the other; B is registered now (D34, D186).
  for (const page of [a, b]) {
    await page.getByTestId('readmission-close').click();
    await expect(page.getByTestId('device')).toHaveCount(2);
    await expect(page.getByTestId('device-last-sync')).not.toContainText('never');
    await expect(page.getByTestId('devices-readmit')).toHaveCount(0);
    await button(page, 'Back').click();
    await expect(page.getByRole('button', { name: /Harbor Bank/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Copper Mail/ })).toBeVisible();
  }

  const secrets = [PASSWORD_A, PASSWORD_B, ...words];
  expect(logged.filter((line) => secrets.some((s) => line.includes(s)))).toEqual([]);
});

test('two devices of different vaults: both say so, and nothing is written (D50, CRYPTO-INV-014)', async ({
  browser,
}) => {
  const logged: string[] = [];
  const a = await device(browser, logged);
  const b = await device(browser, logged);
  await createVault(a, PASSWORD_A);
  await createVault(b, PASSWORD_B);
  await toSas(a, b);
  await button(a, 'Yes, the same').click();
  await button(b, 'Yes, the same').click();
  for (const page of [a, b]) {
    const failed = page.getByTestId('pairing-failed');
    await expect(failed).toHaveAttribute('data-reason', 'different-vaults', { timeout: 30_000 });
    await expect(failed).toContainText('Replace by pairing with another device…');
    await expect(page.getByTestId('device')).toHaveCount(1);
  }
});
