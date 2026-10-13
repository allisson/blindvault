import { type Page, expect, test } from '@playwright/test';

import { createVault } from './create';

// Creation, the reset and each unlock derive Argon2id at about 1 s (D9).
test.setTimeout(180_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';
const NEW_PASSWORD = 'meadow-copper-signal-anchor-3071';
const SECRET = 'Tulip-Orbit-5528-Granite';

function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

async function unlock(page: Page, password: string) {
  await page.getByTestId('unlock-password').fill(password);
  await button(page, 'Unlock').click();
}

test('resets a forgotten local password with the Recovery Phrase, keeping the vault (D173, D184)', async ({
  page,
}) => {
  const logged: string[] = [];
  page.on('console', (message) => logged.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => logged.push(`pageerror: ${String(error.stack ?? error)}`));
  await page.goto('/');
  const words = await createVault(page, PASSWORD);
  await button(page, 'New item').click();
  await button(page, 'Login').click();
  await page.getByTestId('item-title').fill('Only here');
  await page.getByTestId('input-Password').fill(SECRET);
  await button(page, 'Save').click();
  await expect(page.getByRole('heading', { name: 'Only here', level: 1 })).toBeVisible();
  await button(page, 'Lock').click();

  await button(page, 'Forgot the password?').click();
  // Input that is not a phrase: back to the phrase step, emptied, with nothing written.
  await page.getByTestId('reset-phrase').fill(words.slice(0, 23).join(' '));
  await button(page, 'Next').click();
  await page.getByTestId('new-password').fill(NEW_PASSWORD);
  await page.getByTestId('confirm-password').fill(NEW_PASSWORD);
  await button(page, 'Reset the password').click();
  await expect(page.getByText('A Recovery Phrase has 24 words.')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('reset-phrase')).toHaveValue('');

  await page.getByTestId('reset-phrase').fill(words.join(' '));
  await button(page, 'Next').click();
  await page.getByTestId('new-password').fill(NEW_PASSWORD);
  await page.getByTestId('confirm-password').fill(NEW_PASSWORD);
  await button(page, 'Reset the password').click();
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });
  await expect(button(page, 'Only here')).toBeVisible();

  await page.reload();
  await unlock(page, PASSWORD);
  await expect(page.getByText('Wrong password.')).toBeVisible({ timeout: 30_000 });
  await unlock(page, NEW_PASSWORD);
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });
  await expect(button(page, 'Only here')).toBeVisible();

  const secrets = [PASSWORD, NEW_PASSWORD, SECRET, words.join(' ')];
  expect(logged.filter((line) => secrets.some((s) => line.includes(s)))).toEqual([]);
  expect(logged).toEqual([]);
});
