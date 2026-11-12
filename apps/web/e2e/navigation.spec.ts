import { type Page, expect, test } from '@playwright/test';

import { createVault } from './create';

// Icons and navigation (D245): the phone's bottom navigation, New item and the "…" menu in its
// header; the type filter and the counts on every layout.

test.setTimeout(120_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

async function newNote(page: Page, title: string) {
  await button(page, 'New item').click();
  await button(page, 'Secure note').click();
  await page.getByTestId('item-title').fill(title);
  await button(page, 'Save').click();
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
}

test('the phone has New item and a "…" menu with Lock in its header, and Trash below (D245)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/');
  await createVault(page, PASSWORD);
  const footer = page.getByRole('contentinfo');

  await expect(button(page, 'Lock')).toBeHidden();
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked');
  await expect(footer.getByRole('button')).toHaveText(['Items', 'Trash', 'Settings']);
  await expect(button(page, 'Items')).toHaveAttribute('aria-current', 'page');
  // One New item, the header's: the list's own is left out.
  await expect(button(page, 'New item')).toHaveCount(1);
  await expect(button(page, 'New item')).toHaveAttribute('aria-keyshortcuts', 'N');

  await newNote(page, 'Garden plan');
  await button(page, 'Back').click();

  await button(page, 'Trash').click();
  await expect(page.getByRole('heading', { name: 'Trash', level: 2 })).toBeVisible();
  await expect(button(page, 'Trash')).toHaveAttribute('aria-current', 'page');
  await expect(button(page, 'New item')).toBeHidden();
  await button(page, 'Items').click();
  await expect(page.getByRole('heading', { name: 'Items', level: 2 })).toBeVisible();

  // Escape closes the menu; choosing Lock locks.
  await button(page, 'More').click();
  await expect(button(page, 'Lock')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(button(page, 'Lock')).toBeHidden();
  await button(page, 'More').click();
  await button(page, 'Lock').click();
  await expect(page.getByTestId('unlock-password')).toBeVisible();
});

test('filters the list by type, with counts beside the types and the folder pane (D245)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await createVault(page, PASSWORD);
  const pane = page.getByRole('navigation', { name: 'Folders' });
  const list = page.getByRole('region', { name: 'Items' }).getByTestId('row-title');
  const filter = page.getByRole('group', { name: 'Filter by type' });

  await newNote(page, 'Garden plan');
  // One type: nothing to filter.
  await expect(filter).toBeHidden();
  await button(page, 'New item').click();
  await button(page, 'Login').click();
  await page.getByTestId('item-title').fill('Harbor Credit Union');
  await button(page, 'Save').click();
  await expect(page.getByRole('heading', { name: 'Harbor Credit Union', level: 1 })).toBeVisible();

  // The counts are seen, not part of the names.
  await expect(pane.getByRole('button', { name: 'All items', exact: true })).toContainText('2');
  await expect(pane.getByRole('button', { name: 'Trash', exact: true })).toContainText('0');
  await expect(filter.getByRole('button')).toHaveText(['All2', 'Login1', 'Secure note1']);
  await expect(filter.getByRole('button', { name: 'All', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await filter.getByRole('button', { name: 'Secure note', exact: true }).click();
  await expect(list).toHaveText(['Garden plan']);
  await expect(filter.getByRole('button', { name: 'Secure note', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // Harbor Credit Union, just saved, is still shown. The trash then holds one type, so no filter
  // applies there.
  await button(page, 'More actions').click();
  await button(page, 'Move to trash').click();
  await expect(pane.getByRole('button', { name: 'Trash', exact: true })).toContainText('1');
  await pane.getByRole('button', { name: 'Trash', exact: true }).click();
  await expect(filter).toBeHidden();
  await expect(page.getByRole('region', { name: 'Trash' }).getByTestId('row-title')).toHaveText([
    'Harbor Credit Union',
  ]);
  // Kept across lists: back in All items with two types, the notes alone show again.
  await pane.getByRole('button', { name: 'All items', exact: true }).click();
  await newNote(page, 'Tax return');
  await button(page, 'New item').click();
  await button(page, 'Login').click();
  await page.getByTestId('item-title').fill('Mail');
  await button(page, 'Save').click();
  await pane.getByRole('button', { name: 'All items', exact: true }).click();
  await expect(list).toHaveText(['Garden plan', 'Tax return']);
});

test('Settings is an index of pages in groups; a page opens over it and Back returns, then leaves (D252)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/');
  await createVault(page, PASSWORD);
  await button(page, 'Settings').click();

  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  for (const group of ['Preferences', 'Security', 'Devices', 'Data', 'Danger zone']) {
    await expect(page.getByRole('heading', { name: group, level: 2 })).toBeVisible();
  }
  for (const row of [
    'appearance',
    'language',
    'locking',
    'password',
    'passkey',
    'recovery',
    'devices',
    'backup',
    'merge',
    'import',
    'storage',
    'refound',
    'erase',
    'about',
  ]) {
    await expect(page.getByTestId(`settings-${row}`)).toBeVisible();
  }
  // A row shows its current value where one helps: a fresh vault has no backup, and locks after
  // the default 5 minutes (DEFAULT_PREFERENCES).
  await expect(page.getByTestId('settings-backup')).toContainText('Never');
  await expect(page.getByTestId('settings-locking')).toContainText('5 min');

  await page.getByTestId('settings-locking').click();
  await expect(page.getByRole('heading', { name: 'Locking', level: 1 })).toBeFocused();
  await expect(page.getByTestId('autoLockMinutes')).toBeVisible();
  await expect(page.getByTestId('settings-locking')).toHaveCount(0);

  await button(page, 'Back').click();
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await expect(page.getByTestId('settings-locking')).toBeVisible();

  await button(page, 'Back').click();
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toHaveCount(0);
  await expect(button(page, 'New item')).toBeVisible();
});
