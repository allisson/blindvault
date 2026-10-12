import { type Page, expect, test } from '@playwright/test';

// Calibrating Argon2id targets about 1 s per derivation (D9), on every browser.
test.setTimeout(120_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';
const NEXT = 'meadow-copper-signal-ferry-5830';
const WRONG = 'quartz-lantern-velvet-harbor-9215';
const SECRET = 'Tulip-Orbit-5528-Granite';
const ROTATED = 'Cedar-Pixel-0417-Meadow';
const TOTP = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const NOTE = 'PIN is under the blue lamp';

const SECRETS = [PASSWORD, NEXT, WRONG, SECRET, ROTATED, TOTP, NOTE];

async function unlock(page: Page, password: string) {
  await page.getByTestId('unlock-password').fill(password);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  // The same clipboard stand-in as totp.spec.ts: copying works alike in every browser.
  await page.addInitScript(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', { value: () => Promise.resolve() });
  });
});

test('logs nothing, and no secret, through a full use (CRYPTO-INV-005)', async ({ page }) => {
  const logged: string[] = [];
  page.on('console', (message) => logged.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => logged.push(`pageerror: ${String(error.stack ?? error)}`));

  await page.goto('/');
  await page.getByTestId('new-password').fill(PASSWORD);
  await page.getByTestId('confirm-password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create vault', exact: true }).click();
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });

  // An item with a secret, a TOTP secret and a note; a rejected TOTP value first.
  await page.getByRole('button', { name: 'New item', exact: true }).click();
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await page.getByTestId('item-title').fill('ACME');
  await page.getByTestId('input-Password').fill(SECRET);
  await page.getByTestId('item-notes').fill(NOTE);
  await page.getByTestId('add-field-type').selectOption('totp');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByTestId('custom-label').fill('2FA');
  await page.getByTestId('input-2FA').fill(`otpauth://totp/x?secret=${TOTP}&digits=4`);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByTestId('input-2FA').fill(TOTP);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('totp-2FA')).toHaveText(/^[0-9]{3} [0-9]{3}$/);

  // Shown, copied, edited into an Item Version.
  await page.getByRole('button', { name: 'Show', exact: true }).first().click();
  await page.getByRole('button', { name: 'Copy: Password', exact: true }).click();
  await page.getByRole('button', { name: 'Copy code: 2FA', exact: true }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByTestId('input-Password').fill(ROTATED);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.getByRole('button', { name: 'Show', exact: true }).first().click();
  await expect(page.getByText(SECRET)).toBeVisible();

  // Lock, a wrong password, unlock, a password change refused and then made, lock.
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await unlock(page, WRONG);
  await expect(page.getByText('Wrong password.')).toBeVisible({ timeout: 30_000 });
  await unlock(page, PASSWORD);
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Settings' }).first().click();
  const change = page.getByRole('button', { name: 'Change password' });
  await page.getByTestId('current-password').fill(WRONG);
  await page.getByTestId('new-password').fill(NEXT);
  await page.getByTestId('confirm-password').fill(NEXT);
  await change.click();
  await expect(page.getByText('The current password is wrong.')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('current-password').fill(PASSWORD);
  await change.click();
  await expect(page.getByText('Password changed.')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await unlock(page, NEXT);
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });

  expect(SECRETS.filter((s) => logged.some((line) => line.includes(s)))).toEqual([]);
  // The app writes no log at all: nothing to leak, and no page error either.
  expect(logged).toEqual([]);
});
