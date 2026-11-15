import { expect, test } from '@playwright/test';

import { readPhrase } from './create';

// Before its commit, a creation holds its phrase with no vault preferences yet: the hidden-app lock
// runs with the default delay and drops the words from the screen (overview §7, D104, D263).
test('the app hidden for 60 seconds while the new phrase is shown drops it, writing nothing (D263)', async ({
  page,
}) => {
  await page.goto('/');
  await readPhrase(page);
  // Fake time from now on: the hidden-app timer starts after it.
  await page.clock.install();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(59_000);
  await expect(page.getByTestId('recovery-phrase')).toBeVisible();
  await page.clock.runFor(1_000);
  await expect(page.getByTestId('recovery-phrase')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create a new vault', exact: true })).toBeVisible();
  expect(await page.evaluate(async () => (await indexedDB.databases()).length)).toBe(0);
});
