import { type Page, expect, test } from '@playwright/test';

import { createVault } from './create';

// Calibrating Argon2id targets about 1 s per derivation (D9), on every browser.
test.setTimeout(120_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';
const SECRET = 'Tulip-Orbit-5528-Granite';

function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

test('searches in memory, never over secrets, and forgets the query on lock (D132)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await createVault(page, PASSWORD);

  await button(page, '+ New folder').click();
  await page.getByTestId('folder-name').fill('Finance');
  await button(page, 'Create').click();
  await expect(page.getByRole('heading', { name: 'Finance', level: 2 })).toBeVisible();
  await button(page, 'New item').click();
  await button(page, 'Login').click();
  await page.getByTestId('item-title').fill('Harbor Credit Union');
  await page.getByTestId('input-Username').fill('ana.lima');
  await page.getByTestId('input-Password').fill(SECRET);
  await button(page, 'Save').click();
  await expect(page.getByRole('heading', { name: 'Harbor Credit Union', level: 1 })).toBeVisible();
  await button(page, 'All items').click();
  await button(page, 'New item').click();
  await button(page, 'Secure note').click();
  await page.getByTestId('item-title').fill('Garden plan');
  await page.getByTestId('item-notes').fill('Plant the tulips in spring');
  await button(page, 'Save').click();
  await expect(page.getByRole('heading', { name: 'Garden plan', level: 1 })).toBeVisible();

  const search = page.getByTestId('search');
  const results = page.getByRole('region', { name: 'Results' });
  // Ctrl/⌘ + K focuses search.
  await page.keyboard.press('ControlOrMeta+k');
  await expect(search).toBeFocused();
  await search.fill('ANA.LIMA');
  await expect(results.getByRole('listitem')).toHaveText(['Harbor Credit Union']);
  await search.fill('finance');
  await expect(results.getByRole('listitem')).toHaveText(['Harbor Credit Union']);
  await search.fill('tulip');
  // Notes match; the password holding the same word does not.
  await expect(results.getByRole('listitem')).toHaveText(['Garden plan']);
  await search.fill('5528');
  await expect(page.getByText('No items match.')).toBeVisible();
  await search.fill('Orbit-5528');
  await expect(page.getByText('No items match.')).toBeVisible();

  // Nothing of the search is persisted.
  const stored = await page.evaluate(() =>
    Array.from({ length: localStorage.length }, (_, i) => {
      const key = localStorage.key(i) ?? '';
      return `${key}=${localStorage.getItem(key) ?? ''}`;
    }).join('\n'),
  );
  expect(stored).not.toContain('Orbit');

  await button(page, 'Lock').click();
  await page.getByTestId('unlock-password').fill(PASSWORD);
  await button(page, 'Unlock').click();
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });
  await expect(page.getByTestId('search')).toHaveValue('');
  await expect(page.getByRole('region', { name: 'Results' })).toHaveCount(0);
});
