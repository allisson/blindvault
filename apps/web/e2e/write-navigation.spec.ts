import { type Locator, type Page, expect, test } from '@playwright/test';

import { createVault } from './create';

// A write that navigates when it completes does so only if the user is still where it started
// (D210). Each test starts the write and another navigation in the same task, so the other
// navigation always lands while the write is pending.

// Calibrating Argon2id targets about 1 s per derivation (D9), on every browser.
test.setTimeout(120_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';

function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

function heading(page: Page, name: string, level: 1 | 2) {
  return page.getByRole('heading', { name, level, exact: true });
}

/** Clicks `first`, then `second`, in one task: `first`'s write is still pending at the second. */
async function together(first: Locator, second: Locator): Promise<void> {
  const a = await first.elementHandle();
  const b = await second.elementHandle();
  await a.evaluate((x, y) => {
    (x as HTMLElement).click();
    (y as HTMLElement).click();
  }, b);
}

async function newLogin(page: Page, title: string): Promise<void> {
  await button(page, 'New item').click();
  await button(page, 'Login').click();
  await page.getByTestId('item-title').fill(title);
  await button(page, 'Save').click();
  await expect(heading(page, title, 1)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await createVault(page, PASSWORD);
});

test('New item pressed while a new item saves opens a fresh template picker (D210)', async ({
  page,
}) => {
  await button(page, 'New item').click();
  await button(page, 'Login').click();
  await page.getByTestId('item-title').fill('ACME');
  await together(button(page, 'Save'), button(page, 'New item'));
  await expect(button(page, 'ACME')).toBeVisible();
  await expect(heading(page, 'Choose a template', 1)).toBeVisible();
  await button(page, 'Login').click();
  await expect(page.getByTestId('item-title')).toHaveValue('');
});

test('another item chosen while an edit saves stays shown, and the edit is saved (D210)', async ({
  page,
}) => {
  await newLogin(page, 'ACME');
  await newLogin(page, 'Beta');
  await button(page, 'ACME').click();
  await button(page, 'Edit').click();
  await page.getByTestId('item-title').fill('ACME 2');
  await together(button(page, 'Save'), button(page, 'Beta'));
  await expect(button(page, 'ACME 2')).toBeVisible();
  await expect(heading(page, 'Beta', 1)).toBeVisible();
});

test('another item chosen while a version is restored stays shown (D210)', async ({ page }) => {
  await newLogin(page, 'ACME');
  await newLogin(page, 'Beta');
  await button(page, 'ACME').click();
  await button(page, 'Edit').click();
  await page.getByTestId('item-title').fill('ACME 2');
  await button(page, 'Save').click();
  await expect(heading(page, 'ACME 2', 1)).toBeVisible();
  await button(page, 'History').click();
  await together(button(page, 'Restore this version'), button(page, 'Beta'));
  await expect(button(page, 'ACME')).toBeVisible();
  await expect(heading(page, 'Beta', 1)).toBeVisible();
});

test('another item chosen while an item is duplicated stays shown (D210)', async ({ page }) => {
  await newLogin(page, 'ACME');
  await newLogin(page, 'Beta');
  await together(button(page, 'Duplicate'), button(page, 'ACME'));
  await expect(button(page, 'Beta (copy)')).toBeVisible();
  await expect(heading(page, 'ACME', 1)).toBeVisible();
});

test('the trash chosen while a folder is created stays shown (D210)', async ({ page }) => {
  await button(page, '+ New folder').click();
  await page.getByTestId('folder-name').fill('Work');
  await together(button(page, 'Create'), button(page, 'Trash'));
  await expect(button(page, 'Work')).toBeVisible();
  await expect(heading(page, 'Trash', 2)).toBeVisible();
  await expect(heading(page, 'Work', 2)).toHaveCount(0);
});
