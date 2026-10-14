import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { type Page, expect, test } from '@playwright/test';

import { createVault } from './create';

// Calibrating Argon2id targets about 1 s per derivation (D9).
test.setTimeout(120_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';

// The version the build writes to version.txt (D191).
const VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

async function expectAbout(page: Page, hash: string): Promise<void> {
  const about = page.getByTestId('about');
  await expect(about.getByTestId('about-version')).toHaveText(VERSION);
  await expect(about.getByTestId('about-hash')).toHaveText(hash);
  await expect(about).toContainText('shasum -a 256 -c asset-manifest.txt');
  const releases = about.getByRole('link', { name: 'Releases on GitHub' });
  await expect(releases).toHaveAttribute('href', 'https://github.com/allisson/blindvault/releases');
  await expect(releases).toHaveAttribute('rel', 'noopener noreferrer');
}

test('shows the version and the hash of the running build, before unlock and in Settings (D192)', async ({
  page,
  request,
}) => {
  const manifest = await (await request.get('/asset-manifest.txt')).body();
  const hash = createHash('sha256').update(manifest).digest('hex');

  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Create a new vault' })).toBeVisible();
  await page.getByRole('button', { name: 'About', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'About BlindVault' })).toBeVisible();
  await expectAbout(page, hash);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Create a new vault' })).toBeVisible();

  await createVault(page, PASSWORD);
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await expectAbout(page, hash);

  // Opening About before unlock hides the screen without losing what was typed.
  await page.getByRole('button', { name: 'Lock' }).click();
  await page.getByTestId('unlock-password').fill(PASSWORD);
  await page.getByRole('button', { name: 'About', exact: true }).click();
  await expect(page.getByTestId('unlock-password')).toBeHidden();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByTestId('unlock-password')).toHaveValue(PASSWORD);
});
