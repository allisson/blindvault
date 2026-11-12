import { type Page, expect, test } from '@playwright/test';

import { createVault } from './create';

// Feedback (D250): the toast region, the confirmation as a bottom sheet on a phone, the empty
// vault's first steps, and the error boundary that locks the vault before its failure screen.

test.setTimeout(120_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';
const SECRET = 'Tulip-Orbit-5528-Granite';

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

function writes(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { clipboardWrites: string[] }).clipboardWrites);
}

test.beforeEach(async ({ page }) => {
  // Records what the app writes to the clipboard, the same way in every browser.
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

async function login(page: Page, title: string) {
  await page.getByTestId('item-title').fill(title);
  await page.getByTestId('input-Password').fill(SECRET);
  await button(page, 'Save').click();
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
}

test('the empty vault shows its first steps, each opening where it is done (D250)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await createVault(page, PASSWORD);

  const steps = page.getByTestId('first-steps');
  await expect(steps.getByRole('heading', { name: 'First steps' })).toBeVisible();
  await expect(steps.getByRole('listitem')).toHaveCount(4);
  await expect(steps.getByRole('img', { name: 'Done' })).toBeVisible();

  await steps.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Import', exact: true, level: 2 })).toBeFocused();
  await button(page, 'Back').click();

  await steps.getByRole('button', { name: 'Add an item', exact: true }).click();
  await button(page, 'Login').click();
  await login(page, 'ACME');
  await expect(steps).toHaveCount(0);
});

test('copy, save, move to trash and restore show a toast, still under reduced motion (D250)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await createVault(page, PASSWORD);
  const region = page.getByTestId('toast-region');
  await expect(region).toHaveAttribute('role', 'status');

  await button(page, 'New item').click();
  await button(page, 'Login').click();
  await login(page, 'ACME');
  await expect(region).toHaveText('Saved.');
  // No entrance under reduced motion (D236).
  expect(await page.getByTestId('toast').evaluate((t) => getComputedStyle(t).animationName)).toBe(
    'none',
  );

  await button(page, 'Copy: Password').click();
  await expect(region).toContainText(/^Copied\. .* not guaranteed\.$/);
  expect(await writes(page)).toEqual([SECRET]);

  await button(page, 'More actions').click();
  await button(page, 'Move to trash').click();
  await expect(region).toHaveText('Moved to the trash.');

  await button(page, 'Trash').click();
  await page.getByRole('button', { name: /^ACME/ }).click();
  await button(page, 'Restore from the trash').click();
  await expect(region).toHaveText('Restored.');
  // It goes on its own.
  await expect(page.getByTestId('toast')).toHaveCount(0, { timeout: 10_000 });
});

test('a confirmation is a bottom sheet on a phone and a centered dialog wider (D250)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await createVault(page, PASSWORD);
  await page.getByTestId('first-steps').getByRole('button', { name: 'Add an item' }).click();
  await button(page, 'Login').click();
  await page.getByTestId('item-title').fill('Unsaved');
  await button(page, 'Cancel').click();

  const sheet = page.getByTestId('discard-confirm');
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute('data-sheet', 'true');
  // Measured once its entrance ends.
  await sheet.evaluate((d) => Promise.all(d.getAnimations().map((a) => a.finished)));
  const box = await sheet.boundingBox();
  expect(box?.width).toBe(390);
  expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(844);
  // The action first, both full width and at least 44 px tall.
  const buttons = sheet.getByRole('button');
  await expect(buttons.first()).toHaveText('Discard the changes');
  for (const b of await buttons.all()) {
    const at = await b.boundingBox();
    expect(at?.height).toBeGreaterThanOrEqual(44);
  }
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);

  await page.setViewportSize({ width: 1280, height: 900 });
  await button(page, 'Cancel').click();
  await expect(sheet).toBeVisible();
  await expect(sheet).not.toHaveAttribute('data-sheet');
  await sheet.evaluate((d) => Promise.all(d.getAnimations().map((a) => a.finished)));
  expect((await sheet.boundingBox())?.width).toBeLessThan(500);
});

test('a render error locks the vault and clears the clipboard before its failure screen (D250)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await createVault(page, PASSWORD);
  await button(page, 'New item').click();
  await button(page, 'Login').click();
  await login(page, 'ACME');
  await button(page, 'Copy: Password').click();
  await expect.poll(() => writes(page)).toEqual([SECRET]);

  // The list sorts with Intl.Collator on every render: breaking it makes the next render throw.
  await page.evaluate(() => {
    Intl.Collator = function () {
      throw new Error('render failure for the test');
    } as unknown as typeof Intl.Collator;
  });
  await page.getByTestId('search').fill('A');

  await expect(page.getByTestId('crash')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Something went wrong' })).toBeVisible();
  await expect(page.getByText('ACME')).toHaveCount(0);
  await expect(page.getByTestId('lock-state')).toHaveCount(0);
  await expect.poll(() => writes(page)).toEqual([SECRET, '']);

  await button(page, 'Reload').click();
  await expect(page.getByTestId('unlock-password')).toBeVisible();
});
