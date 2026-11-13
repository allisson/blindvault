import { type Page, expect, test } from '@playwright/test';

import { createVault } from './create';
import { lock } from './lock';

// Every local password field holds Show password, an icon button with aria-pressed; it is masked
// when it appears and again on submit, a failed one included, with no timer (D254).

test.setTimeout(120_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';

const toggle = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

test('a password field shows on demand and is masked again on submit (D254)', async ({ page }) => {
  await page.goto('/');
  await createVault(page, PASSWORD);
  await lock(page);

  const field = page.getByTestId('unlock-password');
  await expect(field).toHaveAttribute('type', 'password');
  await field.fill('wrong-password');
  await toggle(page, 'Show password').click();
  await expect(field).toHaveAttribute('type', 'text');
  await expect(toggle(page, 'Hide password')).toHaveAttribute('aria-pressed', 'true');
  await toggle(page, 'Hide password').click();
  await expect(field).toHaveAttribute('type', 'password');

  // A failed unlock masks it again.
  await toggle(page, 'Show password').click();
  await field.press('Enter');
  await expect(page.getByText('Wrong password.', { exact: false })).toBeVisible();
  await expect(field).toHaveAttribute('type', 'password');
  await expect(toggle(page, 'Show password')).toHaveAttribute('aria-pressed', 'false');
});
