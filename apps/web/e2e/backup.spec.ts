import { readFile } from 'node:fs/promises';

import { RecordType } from '@blindvault/crypto';
import { type Page, expect, test } from '@playwright/test';

import { corruptRecords } from './corrupt';
import { createVault } from './create';

// Calibrating Argon2id targets about 1 s per derivation (D9); an export derives twice.
test.setTimeout(180_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';
const WRONG = 'quartz-lantern-velvet-harbor-9215';
const SECRET = 'Tulip-Orbit-5528-Granite';
const MAGIC = [0x89, 0x42, 0x56, 0x41, 0x55, 0x4c, 0x54, 0x0a];

function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

/** Exports with the local password and returns the file the browser received. */
async function exportBackup(page: Page): Promise<{ name: string; bytes: Buffer }> {
  await page.getByTestId('backup-password').fill(PASSWORD);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    button(page, 'Export').click(),
  ]);
  return { name: download.suggestedFilename(), bytes: await readFile(await download.path()) };
}

test('exports a backup, asking for the local password again, then one under a generated passphrase (D36, D134, D155, D181)', async ({
  page,
}) => {
  const logged: string[] = [];
  page.on('console', (message) => logged.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => logged.push(`pageerror: ${String(error.stack ?? error)}`));

  await page.goto('/');
  await createVault(page, PASSWORD);
  await button(page, 'New item').click();
  await button(page, 'Login').click();
  await page.getByTestId('item-title').fill('ACME');
  await page.getByTestId('input-Password').fill(SECRET);
  await button(page, 'Save').click();
  await expect(page.getByRole('heading', { name: 'ACME', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await expect(
    page.getByText(
      'A backup is an encrypted file with a full copy of this vault. Your Recovery Phrase always opens it. Keep copies away from this device, so you can restore if you lose it.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      "A backup holds the vault's Master Key, so exporting asks for your local password again.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByTestId('last-backup')).toHaveText(
    'No backup has been made on this device yet.',
  );
  // No peer's records were rejected: no incomplete-backup warning (D115).
  await expect(page.getByTestId('backup-incomplete')).toHaveCount(0);

  // Another local password makes no file.
  await page.getByTestId('backup-password').fill(WRONG);
  await button(page, 'Export').click();
  await expect(page.getByText('Wrong password. No backup was made.')).toBeVisible({
    timeout: 30_000,
  });

  // The Recovery Phrase only: a `.bvault` file named by the date, holding no plaintext.
  const plain = await exportBackup(page);
  expect(plain.name).toMatch(/^blindvault-\d{4}-\d{2}-\d{2}\.bvault$/);
  expect([...plain.bytes.subarray(0, 8)]).toEqual(MAGIC);
  expect(plain.bytes.includes(SECRET)).toBe(false);
  expect(plain.bytes.includes('ACME')).toBe(false);
  // The status names the phrase the file opens with, by its phraseId and date (D185).
  await expect(page.getByRole('status')).toHaveText(
    new RegExp(
      `^Backup exported as ${plain.name.replaceAll('.', '\\.')}\\. It opens with the Recovery Phrase [0-9a-f]{8}, created on .+\\. Keep it somewhere other than this device\\.$`,
    ),
  );
  await expect(page.getByTestId('last-backup')).toHaveText(
    /^Last backup made on this device: .+\.$/,
  );
  await expect(page.getByTestId('backup-password')).toHaveValue('');

  // An export password: the Master Key warning, a weak one refused, a generated one shown.
  await page.getByTestId('backup-protect').check();
  await expect(page.getByTestId('backup-master-key')).toHaveText(
    "Whoever opens this backup with its export password holds the vault's Master Key for good. If the export password and a copy of the backup are ever exposed together, the vault must be re-founded.",
  );
  await page.getByTestId('export-password').fill('harbor1234');
  await expect(page.getByTestId('export-password')).toHaveAttribute('aria-invalid', 'true');
  // Random but short: no pattern for zxcvbn to name, so the export's own warning (D134).
  await page.getByTestId('export-password').fill('Xq7#vL2p');
  await expect(
    page.getByText(
      'Too easy to guess for a file that can be attacked offline. Use a longer password, or generate a passphrase.',
      { exact: true },
    ),
  ).toBeVisible();
  await page.getByTestId('backup-password').fill(PASSWORD);
  await expect(button(page, 'Export')).toBeDisabled();
  await button(page, 'Generate a passphrase').click();
  const passphrase = await page.getByTestId('export-password').inputValue();
  expect(passphrase.split('-')).toHaveLength(6);
  await expect(page.getByTestId('export-password')).toHaveAttribute('type', 'text');
  await expect(
    page.getByText(
      'Write this passphrase down: it opens the backup without the Recovery Phrase, and BlindVault does not keep it.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(button(page, 'Export')).toBeDisabled();
  await page.getByTestId('export-confirm').fill(passphrase);
  const protectedFile = await exportBackup(page);
  expect([...protectedFile.bytes.subarray(0, 8)]).toEqual(MAGIC);
  // The password keyslot makes the header longer than the first file's.
  expect(protectedFile.bytes.length).toBeGreaterThan(plain.bytes.length);
  expect(protectedFile.bytes.includes(passphrase)).toBe(false);
  // The form resets: no export password is kept on screen.
  await expect(page.getByTestId('backup-protect')).not.toBeChecked();
  await expect(page.getByTestId('export-password')).toHaveCount(0);

  expect(
    logged.filter((line) => [PASSWORD, SECRET, passphrase].some((s) => line.includes(s))),
  ).toEqual([]);
  expect(logged).toEqual([]);
});

test('a record that fails verification makes no backup, and the export names it (D64, D181)', async ({
  page,
}) => {
  await page.goto('/');
  await createVault(page, PASSWORD);
  await button(page, 'New item').click();
  await button(page, 'Login').click();
  await page.getByTestId('item-title').fill('ACME');
  await button(page, 'Save').click();
  await expect(page.getByRole('heading', { name: 'ACME', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Settings' }).first().click();
  // The export reads every record again from storage and verifies it (D181).
  expect(await corruptRecords(page, RecordType.item)).toBeGreaterThan(0);
  let downloaded = false;
  page.on('download', () => {
    downloaded = true;
  });
  await page.getByTestId('backup-password').fill(PASSWORD);
  await button(page, 'Export').click();
  await expect(
    page.getByText(
      /^A record failed verification, so no backup was made: Item [0-9a-f]{8}\. Nothing on this device was changed\.$/,
    ),
  ).toBeVisible({ timeout: 30_000 });
  expect(downloaded).toBe(false);
  await expect(page.getByTestId('last-backup')).toHaveText(
    'No backup has been made on this device yet.',
  );
});
