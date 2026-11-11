import { expect, test } from '@playwright/test';

import { MEMLIMIT } from '@blindvault/crypto';

import { buildVault, install } from './load-fixture';

// A long list scrolls inside its pane, never the page (D239): the header and Lock (on a phone, its
// "…" menu, D245) stay put, and so do New item, search and, on tablet, the Folders button.

test.setTimeout(5 * 60_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';
const WIDTHS = [
  ['mobile', 375, 187],
  ['tablet', 800, 150],
  ['desktop', 1280, 400],
] as const;

for (const [layout, width, listX] of WIDTHS) {
  test(`1,000 items scroll in their pane, the frame stays, on ${layout} (D239)`, async ({
    page,
  }) => {
    const fixture = await buildVault(PASSWORD, { opslimit: 3, memlimit: MEMLIMIT }, 1000, 0);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await install(page, fixture);
    await page.reload();
    await page.getByTestId('unlock-password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 2 * 60_000 });

    const lock = page.getByRole('button', {
      name: layout === 'mobile' ? 'More' : 'Lock',
      exact: true,
    });
    const before = await lock.boundingBox();
    await page.mouse.move(listX, 700);
    await page.mouse.wheel(0, 3000);
    await expect(
      page.getByRole('button', { name: 'Account 0001', exact: true }),
    ).not.toBeInViewport();

    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(await lock.boundingBox()).toEqual(before);
    await expect(lock).toBeInViewport();
    await expect(page.getByRole('button', { name: 'New item', exact: true })).toBeInViewport();
    await expect(page.getByTestId('search')).toBeInViewport();
    if (layout === 'tablet') {
      await expect(page.getByRole('button', { name: 'Folders', exact: true })).toBeInViewport();
    }
    if (layout === 'mobile') {
      await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeInViewport();
    }
  });
}
