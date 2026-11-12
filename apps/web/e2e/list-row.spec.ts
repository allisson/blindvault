import { type Page, expect, test } from '@playwright/test';

import { createVault, openSettingsPage } from './create';

// The list row (D246): avatar, a subtitle of non-secret fields, Copy for the password, and the
// phone's letter groups.

test.setTimeout(120_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

function writes(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { clipboardWrites: string[] }).clipboardWrites);
}

test.beforeEach(async ({ page }) => {
  // The same clipboard stand-in as totp.spec.ts.
  await page.addInitScript(() => {
    const log: string[] = [];
    Object.defineProperty(window, 'clipboardWrites', { value: log });
    Object.defineProperty(navigator.clipboard, 'writeText', {
      value: (text: string) => {
        log.push(text);
        return Promise.resolve();
      },
    });
  });
});

async function newLogin(page: Page, title: string) {
  await button(page, 'New item').click();
  await button(page, 'Login').click();
  await page.getByTestId('item-title').fill(title);
}

test('a row shows non-secret fields only and copies the password, cleared after the timeout (D246)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await createVault(page, PASSWORD);
  await openSettingsPage(page, 'locking');
  await page.getByTestId('clipboardClearSeconds').fill('10');
  await button(page, 'Save').click();
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
  await button(page, 'Back').click();
  await button(page, 'Back').click();

  await newLogin(page, 'Harbor Credit Union');
  await page.getByTestId('input-Username').fill('ana.lima');
  await page.getByTestId('input-Password').fill('Tulip-Orbit-5528-Granite');
  await page.getByTestId('input-Website').fill('https://bank.example/login');
  await page.getByTestId('add-field-type').selectOption('totp');
  await button(page, 'Add').click();
  await page.getByTestId('custom-label').fill('2FA');
  await page.getByTestId('input-2FA').fill(SECRET);
  await button(page, 'Save').click();
  await expect(page.getByRole('heading', { name: 'Harbor Credit Union', level: 1 })).toBeVisible();

  const row = page.getByRole('region', { name: 'Items' }).getByRole('listitem');
  // The title names the row; the subtitle describes it.
  const open = row.getByRole('button', { name: 'Harbor Credit Union', exact: true });
  await expect(open).toHaveAccessibleDescription('ana.lima · bank.example');
  await expect(row).toContainText('H');
  // CRYPTO-INV-024: no password, TOTP secret or code in the row.
  const text = await row.innerHTML();
  expect(text).not.toContain('Tulip-Orbit');
  expect(text).not.toContain(SECRET);
  expect(text).not.toMatch(/\b\d{3} ?\d{3}\b/);

  expect(await writes(page)).toEqual([]);
  await button(page, 'Copy password: Harbor Credit Union').click();
  await expect(page.getByText(/clear the clipboard in 10 s .* not guaranteed/)).toBeVisible();
  expect(await writes(page)).toEqual(['Tulip-Orbit-5528-Granite']);
  await expect
    .poll(() => writes(page), { timeout: 15_000 })
    .toEqual(['Tulip-Orbit-5528-Granite', '']);
});

test('on a phone, items fall under their first letter, seen only (D246)', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/');
  await createVault(page, PASSWORD);
  for (const title of ['Ápice', 'apple', 'Banana', '42 Street']) {
    await newLogin(page, title);
    await button(page, 'Save').click();
    await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
    await button(page, 'Back').click();
  }
  const list = page.getByRole('region', { name: 'Items' }).getByRole('list');
  // The letters are hidden from the accessibility tree: the list still has four items.
  await expect(list.getByRole('listitem')).toHaveCount(4);
  await expect(list.locator('li[aria-hidden="true"]')).toHaveText(['#', 'A', 'B']);
  await expect(list.getByTestId('row-title')).toHaveText(['42 Street', 'Ápice', 'apple', 'Banana']);
});
