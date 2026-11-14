import { expect, test } from '@playwright/test';
import { startScreen } from './create';

test('renders the first screen, with no lock state before a vault exists, and its version', async ({
  page,
}) => {
  await page.goto('/');
  await startScreen(page);
  await expect(page.getByRole('button', { name: 'Restore from a backup' })).toBeVisible();
  await expect(page.getByTestId('lock-state')).toHaveCount(0);
  await expect(page.getByText(/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)).toBeVisible();
});
