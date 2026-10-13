import { type Page, expect, test } from '@playwright/test';

import { answerConfirmation, createVault } from './create';

// Creation, the proof of the user and the new password each derive Argon2id at about 1 s (D9).
test.setTimeout(240_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';
const WRONG = 'quartz-lantern-velvet-harbor-9215';
const NEW_PASSWORD = 'meadow-copper-signal-anchor-3071';
const SECRET = 'Tulip-Orbit-5528-Granite';

function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

async function newLogin(page: Page, title: string) {
  await button(page, 'New item').click();
  await button(page, 'Login').click();
  await page.getByTestId('item-title').fill(title);
  await page.getByTestId('input-Password').fill(SECRET);
  await button(page, 'Save').click();
}

test('re-founds the vault: warnings, proof, new phrase and password, and only the live items carried over (D28, D72, D187)', async ({
  page,
}) => {
  const logged: string[] = [];
  page.on('console', (message) => logged.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => logged.push(`pageerror: ${String(error.stack ?? error)}`));
  await page.goto('/');
  const oldWords = await createVault(page, PASSWORD);
  await newLogin(page, 'ACME');
  await newLogin(page, 'Discarded');
  await button(page, 'Move to trash').click();
  await page.getByRole('button', { name: 'Settings' }).first().click();
  const before = (await page.getByTestId('recovery-current').textContent()) ?? '';

  // The warnings, and the confirmation they need (D46, D72).
  const refound = page.getByTestId('refound');
  await refound.getByTestId('refound-start').click();
  const warnings = refound.getByTestId('refound-warnings');
  await expect(warnings).toContainText('changes that are not on this device are lost');
  await expect(warnings).toContainText('The trash and the history of every item are emptied');
  await expect(warnings).toContainText('whoever already copied the old vault keeps it');
  await expect(refound.getByTestId('refound-corrupt')).toHaveCount(0);
  await expect(refound.getByTestId('refound-rejected')).toHaveCount(0);
  await expect(button(page, 'Continue')).toBeDisabled();
  await refound.getByTestId('refound-understand').check();
  await button(page, 'Continue').click();

  // The proof of the user: a wrong password goes no further (D187).
  await refound.getByTestId('refound-password').fill(WRONG);
  await button(page, 'Confirm').click();
  await expect(refound.getByText('Wrong password.')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('recovery-phrase')).toHaveCount(0);
  await refound.getByTestId('refound-password').fill(PASSWORD);
  await button(page, 'Confirm').click();

  // The new phrase, its confirmation, then the new local password.
  await expect(page.getByTestId('recovery-phrase')).toBeVisible({ timeout: 30_000 });
  const words: string[] = [];
  for (let n = 1; n <= 24; n++) {
    words.push((await page.getByTestId(`phrase-word-${String(n)}`).textContent()) ?? '');
  }
  expect(words).not.toEqual(oldWords);
  await button(page, 'I wrote them down').click();
  await answerConfirmation(page, words);
  await refound.getByTestId('new-password').fill(NEW_PASSWORD);
  await refound.getByTestId('confirm-password').fill(NEW_PASSWORD);
  await button(page, 'Re-found').click();

  // The new vault: the live item only, its own device only, a new phrase (D40, D72).
  await expect(page.getByTestId('refounded')).toContainText(
    'destroy the backups of the old vault',
    {
      timeout: 60_000,
    },
  );
  await expect(page.getByTestId('devices').getByTestId('device')).toHaveCount(1);
  await expect(page.getByTestId('devices').getByTestId('device')).toContainText('(this device)');
  await expect(page.getByTestId('recovery-current')).not.toHaveText(before);
  await expect(page.getByTestId('last-backup')).toHaveText(
    'No backup has been made on this device yet.',
  );
  // The new vault also shows the backup reminder, with its own Dismiss (D188).
  await expect(page.getByTestId('backup-reminder')).toBeVisible();
  await page.getByTestId('refounded').getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByTestId('refounded')).toHaveCount(0);
  expect(await page.evaluate(async () => (await indexedDB.databases()).length)).toBe(1);
  await button(page, 'Back').click();
  await expect(button(page, 'ACME')).toBeVisible();
  await expect(button(page, 'Discarded')).toHaveCount(0);
  await button(page, 'Trash').click();
  await expect(button(page, 'Discarded')).toHaveCount(0);

  // Only the new local password opens it.
  await button(page, 'Lock').click();
  await page.getByTestId('unlock-password').fill(PASSWORD);
  await button(page, 'Unlock').click();
  await expect(page.getByText('Wrong password.')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('unlock-password').fill(NEW_PASSWORD);
  await button(page, 'Unlock').click();
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });
  await expect(button(page, 'ACME')).toBeVisible();

  const secrets = [PASSWORD, WRONG, NEW_PASSWORD, SECRET, ...oldWords, ...words];
  expect(logged.filter((line) => secrets.some((s) => line.includes(s)))).toEqual([]);
  expect(logged).toEqual([]);
});
