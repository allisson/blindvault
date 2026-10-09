import { expect, test } from '@playwright/test';

test('renders the app shell with its version', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'BlindVault' })).toBeVisible();
  await expect(page.getByText(/^v\d+\.\d+\.\d+$/)).toBeVisible();
});
