import { readFile } from 'node:fs/promises';

import { type Page, expect, test } from '@playwright/test';

import { createVault, startScreen } from './create';

// Creation, export and restore each calibrate or derive Argon2id at about 1 s (D9).
test.setTimeout(240_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';
const NEW_PASSWORD = 'meadow-copper-signal-anchor-3071';

function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

function watchLogs(page: Page): string[] {
  const logged: string[] = [];
  page.on('console', (message) => logged.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => logged.push(`pageerror: ${String(error.stack ?? error)}`));
  return logged;
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
  await startScreen(page);
}

test('a restored device is unregistered, is told to get re-admitted, and retires the lost device (D30, D41, D119, D186)', async ({
  page,
}) => {
  const logged = watchLogs(page);
  await page.goto('/');
  const words = await createVault(page, PASSWORD);
  await page.getByRole('button', { name: 'Settings' }).first().click();

  // The creator: its own record only, so it is the only device (D119), with nothing to retire.
  const devices = page.getByTestId('devices');
  await expect(devices.getByTestId('device')).toHaveCount(1);
  await expect(devices.getByTestId('device')).toContainText('(this device)');
  await expect(devices.getByTestId('devices-only')).toBeVisible();
  await expect(devices.getByTestId('device-retire')).toHaveCount(0);
  const name = ((await devices.getByTestId('device').locator('.font-medium').textContent()) ?? '')
    .replace(' (this device)', '')
    .trim();
  expect(name).not.toBe('');

  await page.getByTestId('backup-password').fill(PASSWORD);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    button(page, 'Export').click(),
  ]);
  const backup = await readFile(await download.path());
  await loseStorage(page);

  await button(page, 'Restore from a backup').click();
  await page.getByTestId('restore-file').setInputFiles({
    name: 'blindvault-backup.bvault',
    mimeType: 'application/octet-stream',
    buffer: backup,
  });
  await page.getByTestId('restore-phrase').fill(words.join(' '));
  await button(page, 'Open the backup').click();
  await page.getByTestId('new-password').fill(NEW_PASSWORD);
  await page.getByTestId('confirm-password').fill(NEW_PASSWORD);
  await button(page, 'Restore').click();
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 60_000 });

  // Once, right after the restore, on "Vault ready": re-admission is recommended (D30, D186, D198).
  await expect(page.getByTestId('ready-readmit')).toContainText('only through backups');
  await expect(page.getByTestId('ready-pair')).toHaveCount(0);
  await button(page, 'See the devices').click();
  await expect(page.getByTestId('ready')).toHaveCount(0);

  // Settings keeps it while unregistered: the old device is listed, this one is not.
  await expect(devices.getByTestId('devices-readmit')).toBeVisible();
  await expect(devices.getByTestId('device')).toHaveCount(1);
  await expect(devices.getByTestId('device')).toContainText(name);
  await expect(devices.getByTestId('device')).not.toContainText('(this device)');

  // Retiring asks for a confirmation that says what it is not; cancel writes nothing.
  await devices.getByTestId('device-retire').click();
  const confirm = devices.getByTestId('retire-confirm');
  await expect(confirm).toContainText('cannot be undone');
  await expect(confirm).toContainText('not revocation');
  await expect(confirm).toContainText('re-found the vault');
  await button(page, 'Cancel').click();
  await expect(confirm).toHaveCount(0);
  await expect(devices.getByTestId('device')).toHaveCount(1);

  await devices.getByTestId('device-retire').click();
  await button(page, `Retire ${name}`).click();
  await expect(devices.getByRole('status')).toHaveText(`${name} is retired.`);
  await expect(devices.getByTestId('device')).toHaveCount(0);
  await expect(devices.getByTestId('devices-retired-count')).toHaveText(
    'Retired devices, not shown: 1.',
  );
  // No other non-retired device: now the only one (D119).
  await expect(devices.getByTestId('devices-only')).toBeVisible();
  await expect(devices.getByTestId('devices-readmit')).toHaveCount(0);

  // As stored: still retired after a new unlock.
  await button(page, 'Lock').click();
  await page.getByTestId('unlock-password').fill(NEW_PASSWORD);
  await button(page, 'Unlock').click();
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });
  await expect(page.getByTestId('ready')).toHaveCount(0);
  await expect(page.getByTestId('readmission')).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await expect(devices.getByTestId('devices-retired-count')).toBeVisible();

  const secrets = [PASSWORD, NEW_PASSWORD, ...words];
  expect(logged.filter((line) => secrets.some((s) => line.includes(s)))).toEqual([]);
  expect(logged).toEqual([]);
});
