import { type Page, expect, test } from '@playwright/test';

import { createVault, openDevices } from './create';

// Settings inside the vault frame on tablet and desktop, a drill-down on a phone, and Devices, a
// main destination with the Pair and Re-admit cards (D252, D254, D316).

test.setTimeout(120_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

test('on desktop, the index sits beside the open page (D254)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await createVault(page, PASSWORD);
  await button(page, 'Settings').click();

  // All items and Trash in the sidebar, the index beside it; no page open yet.
  await expect(button(page, 'All items')).toBeVisible();
  await expect(button(page, 'Trash')).toBeVisible();
  await expect(page.getByText('Choose a page.')).toBeVisible();
  await expect(page.getByTestId('settings-devices')).toHaveCount(0);

  // Devices is no page of Settings: it replaces it, with the sidebar beside it (D316).
  await openDevices(page);
  await expect(page.getByTestId('nav-devices')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('settings-appearance')).toHaveCount(0);

  // Pair and Re-admit, each a card with its own button.
  await expect(page.getByRole('heading', { name: 'Pair a device', level: 3 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Re-admit a device', level: 3 })).toBeVisible();
  await expect(page.getByTestId('invite-start')).toBeVisible();
  await expect(page.getByTestId('readmission-start')).toBeVisible();

  // Settings again: a row swaps the page, so Back leads to the index, then out of Settings.
  await button(page, 'Settings').click();
  await page.getByTestId('settings-language').click();
  await expect(page.getByRole('heading', { name: 'Language', level: 1 })).toBeFocused();
  await expect(page.getByTestId('settings-language')).toHaveAttribute('aria-current', 'page');
  // The index stays beside the page.
  await expect(page.getByTestId('settings-appearance')).toBeVisible();
  await page.getByTestId('settings-appearance').click();
  await expect(page.getByRole('heading', { name: 'Appearance', level: 1 })).toBeVisible();
  await button(page, 'Back').click();
  await expect(page.getByText('Choose a page.')).toBeVisible();
  await button(page, 'Back').click();
  await expect(button(page, 'Settings')).toBeVisible();
  await expect(page.getByText('Choose a page.')).toHaveCount(0);

  await button(page, 'Settings').click();
  await button(page, 'Trash').click();
  await expect(page.getByTestId('settings-appearance')).toHaveCount(0);
});

test('on a phone, a page replaces the index (D252)', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await createVault(page, PASSWORD);
  await button(page, 'Settings').click();
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await page.getByTestId('settings-appearance').click();
  await expect(page.getByRole('heading', { name: 'Appearance', level: 1 })).toBeVisible();
  await expect(page.getByTestId('settings-language')).toHaveCount(0);
  // Devices is a tab of its own, not a page (D316).
  await button(page, 'Back').click();
  await expect(page.getByTestId('settings-devices')).toHaveCount(0);
  await openDevices(page);
  await expect(page.getByRole('heading', { name: 'Devices', level: 1 })).toBeVisible();
  await expect(page.getByTestId('settings-appearance')).toHaveCount(0);
});
