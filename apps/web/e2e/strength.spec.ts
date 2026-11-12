import { type Page, expect, test } from '@playwright/test';

import { createVault } from './create';

// The strength of an item's password (D249): a meter and its level in the editor, a Weak badge on
// the detail, and a weak password saved like any other.

test.setTimeout(120_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

test('rates an item password without blocking its save (D249)', async ({ page }) => {
  await page.goto('/');
  await createVault(page, PASSWORD);
  await button(page, 'New item').click();
  await button(page, 'Login').click();
  await page.getByTestId('item-title').fill('Forum');
  const input = page.getByTestId('input-Password');

  await input.fill('password1');
  await expect(page.getByTestId('item-strength')).toHaveAttribute('data-level', 'weak');
  await expect(input).toHaveAccessibleDescription(/^Strength: Weak\. /);

  await input.fill('Tulip-Orbit-5528-Granite-Lantern');
  await expect(page.getByTestId('item-strength')).toHaveAttribute('data-level', 'strong');
  await expect(input).toHaveAccessibleDescription('Strength: Strong.');

  // Weak again, and saved: the rating informs only.
  await input.fill('password1');
  await expect(page.getByTestId('item-strength')).toHaveAttribute('data-level', 'weak');
  await button(page, 'Save').click();
  await expect(page.getByRole('heading', { name: 'Forum', level: 1 })).toBeVisible();
  await expect(page.getByTestId('weak-badge')).toHaveText('Weak');

  await button(page, 'Edit').click();
  await input.fill('Tulip-Orbit-5528-Granite-Lantern');
  await button(page, 'Save').click();
  await expect(page.getByRole('heading', { name: 'Forum', level: 1 })).toBeVisible();
  await expect(page.getByTestId('weak-badge')).toHaveCount(0);
});
