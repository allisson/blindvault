import { type Page, expect, test } from '@playwright/test';

import { createVault, startScreen } from './create';

// Erase (§7, D41, D154, D183, D205): the warning, the Device record advice, the confirmation, then
// no vault. Creation derives Argon2id at about 1 s (D9).
test.setTimeout(120_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';

function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

/** Names of the vault databases this installation holds. */
function databases(page: Page): Promise<string[]> {
  return page.evaluate(async () =>
    (await indexedDB.databases())
      .map((d) => d.name ?? '')
      .filter((n) => n.startsWith('blindvault-')),
  );
}

function watch(page: Page): string[] {
  const logged: string[] = [];
  page.on('console', (message) => logged.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => logged.push(`pageerror: ${String(error.stack ?? error)}`));
  return logged;
}

/** Checks the confirmation, which nothing erases without, and erases. */
async function confirmErase(page: Page) {
  await expect(button(page, 'Erase')).toBeDisabled();
  await page.getByTestId('erase-understood').check();
  await button(page, 'Erase').click();
}

test('erases the unlocked vault from Settings, saying it is the only device (D119, D205)', async ({
  page,
}) => {
  const logged = watch(page);
  await page.goto('/');
  const words = await createVault(page, PASSWORD);
  expect(await databases(page)).toHaveLength(1);

  await page.getByRole('button', { name: 'Settings' }).first().click();
  await button(page, 'Erase this vault from this device…').click();
  const warning = page.getByTestId('erase-warning');
  await expect(warning).toContainText('Changes that exist only on this device are lost.');
  await expect(warning).toContainText('without a backup, it is lost for good');
  // The backup is one click away: the export password field takes the cursor.
  await button(page, 'Make a backup now').click();
  await expect(page.getByTestId('backup-password')).toBeFocused();
  await confirmErase(page);

  await startScreen(page);
  await expect(page.getByTestId('erased')).toContainText('The vault was erased from this device.');
  await expect(page.getByTestId('lock-state')).toHaveText('Locked');
  expect(await databases(page)).toEqual([]);

  // Not kept anywhere: a reload shows the start screen alone.
  await page.reload();
  await startScreen(page);
  await expect(page.getByTestId('erased')).toHaveCount(0);
  expect(await databases(page)).toEqual([]);

  const secrets = [PASSWORD, ...words];
  expect(logged.filter((line) => secrets.some((s) => line.includes(s)))).toEqual([]);
  expect(logged).toEqual([]);
});

test('erases a locked vault without its password, from the unlock screen (D183, D205)', async ({
  page,
}) => {
  const logged = watch(page);
  await page.goto('/');
  await createVault(page, PASSWORD);
  await button(page, 'Lock').click();

  await button(page, 'Erase this vault from this device…').click();
  await expect(page.getByTestId('erase-warning')).toContainText(
    'Its name cannot be shown while the vault is locked.',
  );
  // Cancel leaves the vault as it was.
  await button(page, 'Cancel').click();
  await expect(page.getByTestId('unlock-password')).toBeVisible();
  expect(await databases(page)).toHaveLength(1);

  await button(page, 'Erase this vault from this device…').click();
  await confirmErase(page);
  await startScreen(page);
  await expect(page.getByTestId('erased')).toContainText(
    'Its name cannot be shown while the vault is locked.',
  );
  expect(await databases(page)).toEqual([]);

  // A start chosen: the notice goes.
  await button(page, 'Create a new vault').click();
  await expect(page.getByTestId('recovery-phrase')).toBeVisible();
  expect(logged).toEqual([]);
});

test('a second app window that takes over an erased vault shows the start screen (D51, D205)', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await createVault(page, PASSWORD);
  const second = await context.newPage();
  await second.goto('/');
  await expect(second.getByText('BlindVault is open in another window.')).toBeVisible();

  await page.getByRole('button', { name: 'Settings' }).first().click();
  await button(page, 'Erase this vault from this device…').click();
  await confirmErase(page);
  await startScreen(page);

  await second.getByRole('button', { name: 'Use here' }).click();
  await startScreen(second);
  expect(await databases(second)).toEqual([]);
});
