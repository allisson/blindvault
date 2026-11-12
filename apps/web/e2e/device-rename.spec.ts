import { expect, test } from '@playwright/test';

import { createVault, openSettingsPage } from './create';

// Creation and unlock each derive Argon2id at about 1 s (D9).
test.setTimeout(120_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';

test('renames this device from Settings, refusing an empty or too long name, and keeps it across a lock (D118)', async ({
  page,
}) => {
  await page.goto('/');
  await createVault(page, PASSWORD);
  await openSettingsPage(page, 'devices');

  const device = page.getByTestId('devices').getByTestId('device');
  await device.getByTestId('device-rename').click();
  const field = device.getByTestId('device-name');
  await field.fill('   ');
  await device.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(device).toContainText('Enter a device name.');
  await field.fill('x'.repeat(65));
  await device.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(device).toContainText('longer than 64 characters');

  await field.fill('  Work laptop  ');
  await device.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(device.getByTestId('device-rename-form')).toHaveCount(0);
  await expect(device.locator('span.font-medium')).toHaveText('Work laptop (this device)');

  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await page.getByTestId('unlock-password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });
  await openSettingsPage(page, 'devices');
  await expect(
    page.getByTestId('devices').getByTestId('device').locator('span.font-medium'),
  ).toHaveText('Work laptop (this device)');
});
