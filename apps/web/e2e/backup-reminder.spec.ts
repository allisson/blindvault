import { type Page, expect, test } from '@playwright/test';

import { createVault } from './create';

// Calibrating Argon2id targets about 1 s per derivation (D9); the export and unlocks derive again.
test.setTimeout(180_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';
const DAY = 24 * 60 * 60 * 1000;
// 2026-03-04 at noon, local time.
const T0 = new Date(2026, 2, 4, 12).getTime();

function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

async function relock(page: Page) {
  await button(page, 'Lock').click();
  await page.getByTestId('unlock-password').fill(PASSWORD);
  await button(page, 'Unlock').click();
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });
}

test('reminds to back up a new vault, then again 30 days after the last backup (§13.4, D188)', async ({
  page,
}) => {
  // The clock runs from T0; it only jumps when the test moves it.
  await page.clock.install({ time: T0 });
  await page.goto('/');
  await createVault(page, PASSWORD);
  const reminder = page.getByTestId('backup-reminder');
  await expect(reminder).toContainText('No backup has been made on this device: make one');

  // Dismissed until the next lock, and back after it while due.
  await reminder.getByRole('button', { name: 'Dismiss' }).click();
  await expect(reminder).toHaveCount(0);
  await relock(page);
  await expect(reminder).toBeVisible();

  // "Make a backup" opens Settings with the cursor in the export's password field.
  await reminder.getByRole('button', { name: 'Make a backup' }).click();
  await expect(page.getByTestId('backup-password')).toBeFocused();
  await page.getByTestId('backup-password').fill(PASSWORD);
  await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    button(page, 'Export').click(),
  ]);
  await expect(reminder).toHaveCount(0);
  await button(page, 'Back').click();

  // A day short of 30, no reminder; at 30 days, the reminder names the last backup's date.
  await page.clock.setSystemTime(T0 + 29 * DAY);
  await relock(page);
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked');
  await expect(reminder).toHaveCount(0);
  await page.clock.setSystemTime(T0 + 31 * DAY);
  await relock(page);
  await expect(reminder).toContainText(
    'The last backup made on this device is from March 4, 2026, more than 30 days ago',
  );
});
