import { type Page } from '@playwright/test';

/** Presses Lock: in the header, or on a phone in its "…" menu (D245). */
export async function lock(page: Page): Promise<void> {
  const more = page.getByRole('button', { name: 'More', exact: true });
  if (await more.isVisible()) await more.click();
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
}
