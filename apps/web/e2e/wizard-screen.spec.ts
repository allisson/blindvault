import { type Page, expect, test } from '@playwright/test';

import { createVault } from './create';

// A wizard on a screen of its own: "Next:", Cancel beside the main action or in the header, the
// main action fixed at the bottom on a phone, and the file drop area with Continue (D254).

test.setTimeout(120_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

async function openPairing(page: Page) {
  await button(page, 'Settings').click();
  await page.getByTestId('settings-devices').click();
  await page.getByTestId('invite-start').click();
}

test('on desktop, a wizard in Settings hides the rest of its page (D254)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await createVault(page, PASSWORD);
  await openPairing(page);

  // Only the page's title and the wizard show; the cursor is in the password field.
  await expect(page.getByRole('heading', { name: 'Devices', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Pair a device', level: 2 })).toBeVisible();
  await expect(page.getByTestId('invite-password')).toBeFocused();
  await expect(page.getByTestId('readmission-start')).toBeHidden();
  await expect(page.getByTestId('wizard-step')).toHaveText('Step 1 of 4 · Confirm it is you');
  await expect(page.getByTestId('wizard-next')).toHaveText('Next: Exchange the codes');
  // The index stays beside it.
  await expect(page.getByTestId('settings-appearance')).toBeVisible();

  // Cancel sits beside the step's main action.
  const actions = button(page, 'Start pairing').locator('..');
  await expect(actions.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  await button(page, 'Cancel').click();
  await expect(page.getByTestId('wizard')).toHaveCount(0);
  await expect(page.getByTestId('invite-start')).toBeVisible();
  await expect(page.getByTestId('readmission-start')).toBeVisible();
});

test('on a phone, Cancel is in the header and the main action stays at the bottom (D254)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 640 });
  await page.goto('/');
  await createVault(page, PASSWORD);
  await page.getByRole('button', { name: 'Settings', exact: true }).last().click();
  await page.getByTestId('settings-devices').click();
  await page.getByTestId('invite-start').click();

  const cancel = page.locator('header').getByRole('button', { name: 'Cancel', exact: true });
  await expect(cancel).toBeVisible();
  await expect(page.getByTestId('wizard').getByRole('button', { name: 'Cancel' })).toHaveCount(0);
  const actions = button(page, 'Start pairing').locator('..');
  await expect(actions).toHaveCSS('position', 'sticky');
  await expect(button(page, 'Start pairing')).toBeInViewport();

  await cancel.click();
  await expect(page.getByTestId('wizard')).toHaveCount(0);
  await expect(page.getByTestId('invite-start')).toBeVisible();
});

test('a file step holds the file until Continue, with Cancel in the header (D254)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await button(page, 'Restore from a backup').click();

  await expect(page.getByTestId('wizard-next')).toHaveText('Next: Open the backup');
  await expect(page.locator('header').getByRole('button', { name: 'Cancel' })).toBeVisible();
  await expect(page.getByText('or drop it here · .bvault')).toBeVisible();
  const proceed = page.getByTestId('file-continue');
  await expect(proceed).toBeDisabled();

  await page.getByTestId('restore-file').setInputFiles({
    name: 'not-a-backup.bvault',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('not a backup'),
  });
  // Chosen, not yet read: its name shows, and the step stays.
  await expect(page.getByText('not-a-backup.bvault')).toBeVisible();
  await expect(page.getByTestId('wizard-step')).toHaveText('Step 1 of 3 · Choose the backup');
  await proceed.click();
  await expect(page.getByRole('alert')).toBeVisible();

  await page.locator('header').getByRole('button', { name: 'Cancel' }).click();
  await expect(button(page, 'Restore from a backup')).toBeVisible();
});
