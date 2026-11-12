import { readFile } from 'node:fs/promises';

import { RecordType } from '@blindvault/crypto';
import { type Browser, type Page, expect, test } from '@playwright/test';

import { corruptRecords } from './corrupt';
import { checkSameNetwork, createVault, openSettingsPage, openVault, startScreen } from './create';
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
  await openSettingsPage(page, 'devices');
  await button(page, 'Re-admit with another device of this vault…').click();
  await checkSameNetwork(page.getByTestId('readmit-device'));
  await page.getByTestId(first ? 'readmission-first' : 'readmission-paste').click();
}

/** `a` shows its text, `b` pastes it and answers, `a` connects: both show the same SAS. */
async function toSas(a: Page, b: Page): Promise<void> {
  await startReadmission(a, true);
  const offer = a.getByTestId('pairing-text');
  await expect(offer).not.toHaveValue('', { timeout: 30_000 });
  await startReadmission(b, false);
  await b.getByTestId('pairing-paste').fill(await offer.inputValue());
  await button(b, 'Show my answer').click();
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

/**
 * A holds a vault with an item and exports it; B restores that backup, so it is unregistered, and
 * adds an item of its own.
 */
async function restored(browser: Browser, logged: string[]) {
  const a = await device(browser, logged);
  const words = await createVault(a, PASSWORD_A);
  await addItem(a, 'Harbor Bank');
  await openSettingsPage(a, 'backup');
  await a.getByTestId('backup-password').fill(PASSWORD_A);
  const [download] = await Promise.all([
    a.waitForEvent('download', { timeout: 60_000 }),
    button(a, 'Export').click(),
  ]);
  const backup = await readFile(await download.path());
  await button(a, 'Back').click();
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

  return { a, b, words };
}

test('re-admits a restored device: both know each other and hold every item (§9, D22, D207)', async ({
  browser,
}) => {
  const logged: string[] = [];
  const { a, b, words } = await restored(browser, logged);
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
    await button(page, 'Back').click();
    await expect(page.getByRole('button', { name: /Harbor Bank/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Copper Mail/ })).toBeVisible();
  }

  const secrets = [PASSWORD_A, PASSWORD_B, ...words];
  expect(logged.filter((line) => secrets.some((s) => line.includes(s)))).toEqual([]);
});

test('a pairing answered by a device of the vault is refused, and a restored device that pairs a new one is told to re-admit (D207)', async ({
  browser,
}) => {
  const logged: string[] = [];
  const { a, b } = await restored(browser, logged);

  // A invites; B answers from its re-admission, as a device that already holds the vault.
  await openSettingsPage(a, 'devices');
  await button(a, 'Pair a device…').click();
  await checkSameNetwork(a);
  await fillPassword(a.getByTestId('invite-password'), PASSWORD_A);
  await button(a, 'Start pairing').click();
  const offer = a.getByTestId('pairing-text');
  await expect(offer).not.toHaveValue('', { timeout: 30_000 });
  await startReadmission(b, false);
  await b.getByTestId('pairing-paste').fill(await offer.inputValue());
  await button(b, 'Show my answer').click();
  const answer = b.getByTestId('pairing-text');
  await expect(answer).not.toHaveValue('', { timeout: 30_000 });
  await a.getByTestId('pairing-paste').fill(await answer.inputValue());
  await button(a, 'Connect').click();
  await expect(
    a.getByText(
      'That device already holds a vault: to re-admit it, cancel here and choose “Re-admit with another device of this vault…” on both devices.',
      { exact: true },
    ),
  ).toBeVisible();
  await button(b, 'Cancel').click();

  // B, restored and unregistered, pairs a new device C: the others know neither yet.
  await button(b, 'Pair a device…').click();
  await checkSameNetwork(b.getByTestId('invite'));
  await fillPassword(b.getByTestId('invite-password'), PASSWORD_B);
  await button(b, 'Start pairing').click();
  const invite = b.getByTestId('pairing-text');
  await expect(invite).not.toHaveValue('', { timeout: 30_000 });
  const c = await device(browser, logged);
  await startScreen(c);
  await button(c, 'Pair with an existing device').click();
  await fillPassword(c.getByTestId('new-password'), PASSWORD_A);
  await fillPassword(c.getByTestId('confirm-password'), PASSWORD_A);
  await checkSameNetwork(c);
  await button(c, 'Start pairing').click();
  await c.getByTestId('pairing-paste').fill(await invite.inputValue(), { timeout: 30_000 });
  await button(c, 'Show my answer').click();
  const reply = c.getByTestId('pairing-text');
  await expect(reply).not.toHaveValue('', { timeout: 30_000 });
  await b.getByTestId('pairing-paste').fill(await reply.inputValue());
  await button(b, 'Connect').click();
  await expect(b.getByTestId('pairing-sas')).toHaveText(/^\d{3} \d{3}$/, { timeout: 30_000 });
  await button(b, 'Yes, the same').click();
  await button(c, 'Yes, the same').click();
  await expect(b.getByTestId('pairing-done')).toBeVisible({ timeout: 60_000 });
  await expect(
    b.getByText(
      /^The other devices of this vault do not know this device or .+ yet: re-admit this device with one of them, so they can sync with both\.$/,
    ),
  ).toBeVisible();
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

test('numbers said to differ stop the re-admission on both, and nothing is merged (§9, D234, CRYPTO-INV-011)', async ({
  browser,
}) => {
  const logged: string[] = [];
  const { a, b } = await restored(browser, logged);
  await toSas(a, b);
  await button(b, 'No, it differs').click();
  for (const page of [a, b]) {
    const failed = page.getByTestId('pairing-failed');
    await expect(failed).toHaveAttribute('data-reason', 'sas-mismatch', { timeout: 30_000 });
    await expect(failed).toContainText('The numbers differ, so the re-admission stopped');
    await expect(failed).toContainText('carry them some other way');
  }

  // Neither knows the other, and neither holds the other's item.
  await expect(a.getByTestId('device')).toHaveCount(1);
  await expect(b.getByTestId('devices-readmit')).toBeVisible();
  await button(a, 'Back').click();
  await button(a, 'Back').click();
  await expect(a.getByRole('button', { name: /Copper Mail/ })).toHaveCount(0);
});

test('a stored record of A that fails verification stops the re-admission on both before the merge (§9, D181, CRYPTO-INV-018)', async ({
  browser,
}) => {
  const logged: string[] = [];
  const { a, b } = await restored(browser, logged);
  // Every record is read again from storage and verified before it is sent (D181).
  expect(await corruptRecords(a, RecordType.item)).toBeGreaterThan(0);
  await toSas(a, b);
  await button(a, 'Yes, the same').click();
  await button(b, 'Yes, the same').click();
  for (const page of [a, b]) {
    const failed = page.getByTestId('pairing-failed');
    await expect(failed).toHaveAttribute('data-reason', 'verification-failed', { timeout: 60_000 });
    await expect(failed).toContainText(
      'A stored record failed verification, so the re-admission stopped before the merge.',
    );
  }

  // A admitted B before the transfer, so it lists B as not completed, and holds nothing of B.
  await expect(a.getByTestId('device')).toHaveCount(2);
  await expect(a.getByTestId('device-pending')).toHaveText(
    'Pairing not completed: this device never got the confirmation that the other one kept the vault.',
  );
  await button(a, 'Back').click();
  await button(a, 'Back').click();
  await expect(a.getByRole('button', { name: /Copper Mail/ })).toHaveCount(0);
});
