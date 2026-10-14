// The alert a form shows, apart from the storage warning, which stays on screen wherever it applies
// (D196): Chromium headless does not keep storage, and Playwright's WebKit is Safari in a tab.

import { type Locator, type Page } from '@playwright/test';

export function formAlert(page: Page): Locator {
  return page.getByRole('alert').and(page.locator(':not([data-testid="storage-warning"])'));
}
