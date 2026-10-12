import { type Page, expect, test } from '@playwright/test';

// Calibrating Argon2id targets about 1 s per derivation (D9), on every browser.
test.setTimeout(90_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';
const NEXT = 'meadow-copper-signal-ferry-5830';

async function create(page: Page, password = PASSWORD) {
  await page.goto('/');
  await page.getByTestId('new-password').fill(password);
  await page.getByTestId('confirm-password').fill(password);
  await page.getByRole('button', { name: 'Create vault' }).click();
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });
}

async function unlock(page: Page, password: string) {
  await page.getByTestId('unlock-password').fill(password);
  await page.getByRole('button', { name: 'Unlock' }).click();
}

test('refuses a weak or mismatched password before creating (D71)', async ({ page }) => {
  await page.goto('/');
  const submit = page.getByRole('button', { name: 'Create vault' });
  await page.getByTestId('new-password').fill('password123');
  await page.getByTestId('confirm-password').fill('password123');
  await expect(submit).toBeDisabled();
  await page.getByTestId('new-password').fill(PASSWORD);
  await page.getByTestId('confirm-password').fill(`${PASSWORD}x`);
  await expect(page.getByText('The passwords do not match.')).toBeVisible();
  await expect(submit).toBeDisabled();
  await expect(page.getByTestId('phase1-banner')).toBeVisible();
});

test('creates, locks, refuses a wrong password and unlocks, keeping the URL and history', async ({
  page,
}) => {
  await create(page);
  await expect(page.getByTestId('phase1-banner')).toBeVisible();
  const before = await page.evaluate(() => window.history.length);
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Lock' }).click();
  await expect(page.getByTestId('lock-state')).toHaveText('Locked');
  await unlock(page, 'not the password at all');
  await expect(page.getByText('Wrong password.')).toBeVisible({ timeout: 30_000 });
  await unlock(page, PASSWORD);
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });
  // D167: no vault identifier or screen in the URL or the history.
  expect(new URL(page.url()).pathname).toBe('/');
  expect(new URL(page.url()).search + new URL(page.url()).hash).toBe('');
  expect(await page.evaluate(() => window.history.length)).toBe(before);
});

test('keeps the vault after a reload, locked', async ({ page }) => {
  await create(page);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Unlock the vault' })).toBeVisible();
  await unlock(page, PASSWORD);
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });
});

test('changes the password only with the current one (D168)', async ({ page }) => {
  await create(page);
  await page.getByRole('button', { name: 'Settings' }).first().click();
  const change = page.getByRole('button', { name: 'Change password' });
  await page.getByTestId('current-password').fill('not the password at all');
  await page.getByTestId('new-password').fill(NEXT);
  await page.getByTestId('confirm-password').fill(NEXT);
  await change.click();
  await expect(page.getByText('The current password is wrong.')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('current-password').fill(PASSWORD);
  await change.click();
  await expect(page.getByText('Password changed.')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Lock' }).click();
  await unlock(page, PASSWORD);
  await expect(page.getByText('Wrong password.')).toBeVisible({ timeout: 30_000 });
  await unlock(page, NEXT);
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });
});

test('refuses a lock preference outside its range (D151)', async ({ page }) => {
  await create(page);
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByTestId('autoLockMinutes').fill('0');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('A value is outside its range.')).toBeVisible();
  await page.getByTestId('autoLockMinutes').fill('10');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
});

test('switches layout with the viewport width without locking (D15)', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await create(page);
  const shell = page.locator('[data-layout]');
  await expect(shell).toHaveAttribute('data-layout', 'mobile');
  await page.setViewportSize({ width: 800, height: 800 });
  await expect(shell).toHaveAttribute('data-layout', 'tablet');
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(shell).toHaveAttribute('data-layout', 'desktop');
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked');
});

test('a second app window does not open the vault, and takes it over (D51)', async ({
  page,
  context,
}) => {
  await create(page);
  const second = await context.newPage();
  await second.goto('/');
  await expect(second.getByText('BlindVault is open in another window.')).toBeVisible();
  await second.getByRole('button', { name: 'Use here' }).click();
  await expect(second.getByRole('heading', { name: 'Unlock the vault' })).toBeVisible();
  await expect(page.getByText('BlindVault is open in another window.')).toBeVisible();
  await expect(page.getByTestId('lock-state')).toHaveText('Locked');
});

test.describe('in Portuguese', () => {
  test.use({ locale: 'pt-BR' });

  test('shows the UI in pt-BR (D165)', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Criar um cofre' })).toBeVisible();
    await expect(page.getByTestId('lock-state')).toHaveText('Bloqueado');
  });
});
