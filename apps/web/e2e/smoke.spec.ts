import { expect, test } from '@playwright/test';

test('renders the first screen, locked, with its version', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Create a new vault' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restore from a backup' })).toBeVisible();
  await expect(page.getByTestId('lock-state')).toHaveText('Locked');
  await expect(page.getByText(/^v\d+\.\d+\.\d+$/)).toBeVisible();
});
