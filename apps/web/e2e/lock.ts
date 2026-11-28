import { type Page } from '@playwright/test';

/** Presses Lock: Lock now in the sidebar, Lock in a tablet's or a phone's header (D316). */
export async function lock(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Lock( now)?$/ }).click();
}
