import { type Page, expect, test } from '@playwright/test';

import { createVault } from './create';

// Calibrating Argon2id targets about 1 s per derivation (D9), on every browser.
test.setTimeout(120_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';
const OLD = 'Tulip-Orbit-5528-Granite';
const NEW = 'Cedar-Pixel-0417-Meadow';

const WIDTHS = [
  ['mobile', 375],
  ['desktop', 1280],
] as const;

function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

for (const [layout, width] of WIDTHS) {
  test(`shows the history, restores a version and duplicates an item on ${layout} (D135, D156, D169)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await createVault(page, PASSWORD);

    await button(page, '+ New folder').click();
    await page.getByTestId('folder-name').fill('Work');
    await button(page, 'Create').click();
    await button(page, 'New item').click();
    await button(page, 'Login').click();
    await page.getByTestId('item-title').fill('Harbor');
    await page.getByTestId('input-Password').fill(OLD);
    await button(page, 'Save').click();
    await button(page, 'Edit').click();
    await page.getByTestId('input-Password').fill(NEW);
    await button(page, 'Save').click();
    await expect(page.getByRole('heading', { name: 'Harbor', level: 1 })).toBeVisible();

    // The history says old values stay, and keeps them masked.
    await button(page, 'History').click();
    await expect(page.getByRole('heading', { name: 'History of Harbor' })).toBeVisible();
    await expect(page.getByText(/Earlier values stay in this history/)).toBeVisible();
    await expect(
      page.getByText(/duplicate the item and move the original to the trash/),
    ).toBeVisible();
    await expect(page.locator('article').getByRole('listitem')).toHaveCount(1);
    await expect(page.getByText(OLD)).toHaveCount(0);
    await button(page, 'Show').click();
    await expect(page.getByTestId('secret-Password')).toHaveText(OLD);
    await button(page, 'Restore this version').click();
    await expect(page.getByRole('heading', { name: 'Harbor', level: 1 })).toBeVisible();
    await button(page, 'Show').click();
    await expect(page.getByTestId('secret-Password')).toHaveText(OLD);

    // The copy: same folder, current content, the suffix, no history.
    await button(page, 'Duplicate').click();
    await expect(page.getByRole('heading', { name: 'Harbor (copy)', level: 1 })).toBeVisible();
    await expect(page.getByText('Work', { exact: true }).last()).toBeVisible();
    await button(page, 'Show').click();
    await expect(page.getByTestId('secret-Password')).toHaveText(OLD);
    await button(page, 'History').click();
    await expect(page.getByText('No earlier versions.')).toBeVisible();
    await button(page, 'Back to the item').click();

    // The original in the trash: only restore, no Duplicate (D140).
    if (layout === 'mobile') await button(page, 'Back').click();
    await button(page, 'Harbor').click();
    await page
      .locator('article')
      .getByRole('button', { name: 'Move to trash', exact: true })
      .click();
    if (layout === 'mobile') {
      await expect(page.getByRole('heading', { name: 'Harbor', level: 1 })).toHaveCount(0);
      await button(page, 'Back').click();
    }
    await button(page, 'Trash').click();
    await button(page, 'Harbor').click();
    await expect(button(page, 'Restore')).toBeVisible();
    await expect(button(page, 'Duplicate')).toHaveCount(0);
    await expect(button(page, 'History')).toHaveCount(0);
  });
}
