import { expect, test } from '@playwright/test';

import { createVault } from './create';

// Calibrating Argon2id targets about 1 s per derivation (D9), on every browser.
test.setTimeout(120_000);

for (const theme of ['light', 'dark'] as const) {
  test(`each accent swatch shows its own color, ${theme} theme (D239)`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto('/');
    await createVault(page, 'quartz-lantern-velvet-harbor-9214');
    await page.getByRole('button', { name: 'Settings' }).first().click();
    const swatches = page.locator('fieldset span[data-accent]');
    await expect(swatches).toHaveCount(6);
    const colors = await swatches.evaluateAll((spans) =>
      spans.map((s) => getComputedStyle(s).backgroundColor),
    );
    expect(new Set(colors).size).toBe(6);
  });
}
