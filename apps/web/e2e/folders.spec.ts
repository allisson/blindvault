import { type Page, expect, test } from '@playwright/test';

// Calibrating Argon2id targets about 1 s per derivation (D9), on every browser.
test.setTimeout(120_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';

const WIDTHS = [
  ['mobile', 375],
  ['tablet', 800],
  ['desktop', 1280],
] as const;

type Layout = (typeof WIDTHS)[number][0];

function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

/** Shows the folder pane: on the root screen on mobile, in the drawer on tablet. */
async function folders(page: Page, layout: Layout) {
  if (layout === 'mobile') {
    while (await button(page, 'Back').isVisible()) await button(page, 'Back').click();
  }
  if (layout === 'tablet' && !(await button(page, 'All items').isVisible())) {
    await button(page, 'Folders').click();
  }
}

async function newFolder(page: Page, name: string) {
  await button(page, '+ New folder').click();
  await page.getByTestId('folder-name').fill(name);
  await button(page, 'Create').click();
}

for (const [layout, width] of WIDTHS) {
  test(`creates, renames, moves, trashes and restores folders on ${layout}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await page.getByTestId('new-password').fill(PASSWORD);
    await page.getByTestId('confirm-password').fill(PASSWORD);
    await button(page, 'Create vault').click();
    await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });
    const list = page.getByRole('region').filter({ has: page.getByRole('heading', { level: 2 }) });

    await folders(page, layout);
    await newFolder(page, 'Work');
    await expect(page.getByRole('heading', { name: 'Work', level: 2 })).toBeVisible();
    await expect(page.getByText('This folder is empty.')).toBeVisible();

    // A subfolder, then an item created while Work is shown lands in Work.
    await button(page, 'New subfolder').click();
    await page.getByTestId('folder-name').fill('Clients');
    await button(page, 'Create').click();
    await expect(page.getByRole('heading', { name: 'Clients', level: 2 })).toBeVisible();
    await folders(page, layout);
    await button(page, 'Work').click();
    await expect(button(page, '▸ Clients')).toBeVisible();
    await button(page, 'New item').click();
    await button(page, 'Secure note').click();
    await expect(page.getByTestId('item-folder')).toHaveValue(/.+/);
    await page.getByTestId('item-title').fill('Contract');
    await button(page, 'Save').click();
    await expect(page.getByRole('heading', { name: 'Contract', level: 1 })).toBeVisible();

    // Rename; the folder cannot move into its own subtree (D171).
    await folders(page, layout);
    await button(page, 'Work').click();
    await button(page, 'Rename').click();
    await page.getByTestId('folder-name').fill('  Office ');
    await button(page, 'Rename').last().click();
    await expect(page.getByRole('heading', { name: 'Office', level: 2 })).toBeVisible();
    await button(page, 'Move').click();
    await expect(page.getByTestId('move-target').locator('option')).toHaveText([
      'No folder (vault root)',
    ]);
    await button(page, 'Move').first().click();

    // Move Clients to the root, then the item into Clients.
    await button(page, '▸ Clients').click();
    await button(page, 'Move').click();
    await page.getByTestId('move-target').selectOption({ label: 'No folder (vault root)' });
    await button(page, 'Move').last().click();
    await folders(page, layout);
    await button(page, 'Office').click();
    await expect(button(page, '▸ Clients')).toHaveCount(0);
    await button(page, 'Contract').click();
    await button(page, 'Edit').click();
    await page.getByTestId('item-folder').selectOption({ label: 'Clients' });
    await button(page, 'Save').click();
    await expect(page.getByRole('article').getByText('Clients', { exact: true })).toBeVisible();

    // Trash Clients with its item; both come back with the folder.
    await folders(page, layout);
    await button(page, 'Clients').click();
    await expect(list.getByRole('button', { name: 'Contract', exact: true })).toBeVisible();
    await button(page, 'Move to trash').click();
    await expect(page.getByRole('heading', { name: 'Clients', level: 2 })).toHaveCount(0);
    await folders(page, layout);
    await expect(button(page, 'Clients')).toHaveCount(0);
    await button(page, 'All items').click();
    await expect(page.getByText('No items yet.')).toBeVisible();
    await folders(page, layout);
    await button(page, 'Trash').click();
    await expect(page.getByText('Folder: Clients')).toBeVisible();
    await expect(button(page, 'Contract')).toBeVisible();
    await button(page, 'Restore Clients').click();
    await expect(page.getByText('The trash is empty.')).toBeVisible();
    await folders(page, layout);
    await button(page, 'Clients').click();
    await expect(button(page, 'Contract')).toBeVisible();
  });
}
