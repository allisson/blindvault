import { type Page, expect, test } from '@playwright/test';

import { FUTURE_CLOCK_BOUND_MS } from '@blindvault/vault';

import { createVault } from './create';

// The device clock goes back after the vault was written ahead (§9.2, D73, D149, D221): the vault is
// read-only until the clock catches up, every screen that writes says why, and writing resumes on
// its own once the clock gets there.

// Creation and each unlock run Argon2id at about 1 s (D9).
test.setTimeout(180_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';
const TITLE = 'Harbor Bank';
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
// 2026-03-04 at noon, local time; the vault is written 400 days later.
const T0 = new Date(2026, 2, 4, 12).getTime();
const AHEAD = T0 + 400 * DAY;
const UNTIL = AHEAD - FUTURE_CLOCK_BOUND_MS;

const BEHIND = `This device's clock went back, so the vault is read-only until ${new Intl.DateTimeFormat(
  'en',
  { dateStyle: 'long', timeStyle: 'short' },
).format(UNTIL)}. Sync still receives records.`;
const FAR =
  'Changes made while the clock was wrong exist only on this device, since your other devices rejected them, and stay readable so you can copy them by hand. To write before then, re-found the vault.';
const PAIR_AGAIN = 'Or replace this device’s vault by pairing with another device';
const ITEM_CLOCK =
  "This item is dated ahead of this device's clock. It can be changed once the clock reaches that date.";

function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

async function relock(page: Page) {
  await button(page, 'Lock').click();
  await page.getByTestId('unlock-password').fill(PASSWORD);
  await button(page, 'Unlock').click();
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });
}

test('a clock gone back makes the vault read-only, each screen says why, and writing resumes once the clock gets there (§9.2, D73, D149)', async ({
  page,
}) => {
  // Fixed until the item is saved, so the vault is written at AHEAD exactly however long creation
  // takes; setSystemTime lets the clock run again.
  await page.clock.install({ time: AHEAD });
  await page.clock.setFixedTime(AHEAD);
  await page.goto('/');
  await createVault(page, PASSWORD);
  await button(page, 'New item').click();
  await button(page, 'Login').click();
  await page.getByTestId('item-title').fill(TITLE);
  await button(page, 'Save').click();
  await expect(page.getByRole('heading', { name: TITLE })).toBeVisible();

  // 400 days back: more than the future-clock bound, so the ways out are offered; no other device,
  // so not pairing again.
  await page.clock.setSystemTime(T0);
  await relock(page);
  const notice = page.getByTestId('clock-behind');
  await expect(notice).toContainText(BEHIND);
  await expect(notice).toContainText(FAR);
  await expect(page.getByTestId('clock-refound')).toBeVisible();
  await expect(notice).not.toContainText(PAIR_AGAIN);
  await expect(button(page, 'New item')).toHaveCount(0);

  // The item is dated ahead of the clock: read-only, saying until when.
  await page.getByRole('button', { name: new RegExp(TITLE) }).click();
  await expect(page.getByText(ITEM_CLOCK)).toBeVisible();
  await expect(button(page, 'Edit')).toHaveCount(0);

  // Settings: no pairing, no re-admission and no new Recovery Phrase while read-only.
  await button(page, 'Settings').click();
  await expect(page.getByTestId('invite')).toContainText(
    'The device clock went back, so the vault is read-only: pairing comes back once writing does.',
  );
  await expect(button(page, 'Pair a device…')).toHaveCount(0);
  await expect(page.getByTestId('readmit-device')).toContainText(
    'The device clock went back, so the vault is read-only: re-admission comes back once writing does.',
  );
  await expect(page.getByTestId('regenerate')).toContainText(
    "This device's clock went back, so the vault is read-only. The Recovery Phrase can be regenerated from",
  );
  await expect(page.getByTestId('regenerate-start')).toHaveCount(0);
  await button(page, 'Back').click();

  // A minute before writing resumes: within the bound, so only the date is shown.
  await page.clock.setSystemTime(UNTIL - MINUTE);
  await relock(page);
  await expect(notice).toContainText(BEHIND);
  await expect(notice).not.toContainText(FAR);
  await expect(page.getByTestId('clock-refound')).toHaveCount(0);

  // Once the clock gets there, the vault is writable again with no unlock, and so is the item (the
  // inactivity lock is minutes away).
  await page.clock.runFor(MINUTE + 1_000);
  await expect(notice).toHaveCount(0);
  await expect(button(page, 'New item')).toBeVisible();
  await page.getByRole('button', { name: new RegExp(TITLE) }).click();
  await expect(button(page, 'Edit')).toBeVisible();
  await expect(page.getByText(ITEM_CLOCK)).toHaveCount(0);
});
