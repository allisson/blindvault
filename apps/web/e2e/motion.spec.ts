import { type Page, expect, test } from '@playwright/test';

import { createVault } from './create';

// Microinteractions (overview §13.7, D231): CSS only, opacity and transform, and nothing animates
// for a user who asked for reduced motion.

// Calibrating Argon2id targets about 1 s per derivation (D9), on every browser.
test.setTimeout(120_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';

test.beforeEach(async ({ page }) => {
  // The clipboard write succeeds the same way in every browser (see totp.spec.ts).
  await page.addInitScript(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', { value: () => Promise.resolve() });
  });
});

async function newLogin(page: Page) {
  await page.goto('/');
  await createVault(page, PASSWORD);
  await page.getByRole('button', { name: 'New item', exact: true }).click();
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await page.getByTestId('item-title').fill('ACME');
  await page.getByTestId('input-Password').fill('Tulip-Orbit-5528-Granite');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ACME' })).toBeVisible();
}

/** The animations and transitions running or pending on the page. */
function animations(page: Page): Promise<number> {
  return page.evaluate(() => document.getAnimations().length);
}

test('a copy shows a check for 1.5 s and keeps its clipboard note (D54, D231)', async ({
  page,
}) => {
  await newLogin(page);
  const copy = page.getByRole('button', { name: 'Copy: Password', exact: true });
  const check = copy.getByTestId('copy-check');
  await copy.click();
  await expect(check).toBeVisible();
  await expect(check).toHaveCount(0, { timeout: 3_000 });
  await expect(page.getByText(/clear the clipboard in \d+ s .* not guaranteed/)).toBeVisible();
});

test('nothing animates under prefers-reduced-motion, and the check still shows (D231)', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await newLogin(page);

  // A press held down, then the copy check. The press is counted while held: a click lets its
  // 150 ms transition end before anything can count it.
  const copy = page.getByRole('button', { name: 'Copy: Password', exact: true });
  await copy.hover();
  await page.mouse.down();
  expect(await animations(page)).toBe(0);
  await page.mouse.up();
  await expect(copy.getByTestId('copy-check')).toBeVisible();
  expect(await animations(page)).toBe(0);

  // A dialog's entrance.
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByTestId('item-title').fill('ACME 2');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByTestId('discard-confirm')).toBeVisible();
  expect(await animations(page)).toBe(0);
});
