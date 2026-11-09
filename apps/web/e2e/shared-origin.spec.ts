import { expect, test } from '@playwright/test';

import { createVault, startScreen } from './create';

// An origin other sites share (D90): the app served under a sub-path of a github.io host warns on
// every screen, before and after unlock; served from its own address, it does not.

const SHARED = 'https://allisson.github.io';
const TEXT =
  'This copy of BlindVault runs under a sub-path of a github.io address, which other sites share: they can read and delete its storage. Do not keep anything here; use a copy served from its own address.';

test.setTimeout(120_000);

test.describe('under a sub-path of a github.io host', () => {
  // A routed origin: page.route sees no request a service worker answers.
  test.use({ serviceWorkers: 'block' });

  test('warns on the start screen and in the vault (D90)', async ({ page, context, baseURL }) => {
    // The same build, answered from the local server: the sub-path is dropped, assets sit at the root.
    await context.route(`${SHARED}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname.replace(/^\/blindvault(?=\/)/, '');
      const local = new URL(path, baseURL);
      // Firefox keeps the routed Host header, which the preview server refuses.
      const headers = { ...route.request().headers(), host: local.host };
      await route.fulfill({ response: await route.fetch({ url: local.href, headers }) });
    });
    await page.goto(`${SHARED}/blindvault/`);
    await startScreen(page);
    await expect(page.getByTestId('shared-origin')).toHaveText(TEXT);
    await createVault(page, 'shared-origin correct horse battery');
    await expect(page.getByTestId('shared-origin')).toHaveText(TEXT);
  });
});

test('warns of no shared origin on its own address (D90)', async ({ page }) => {
  await page.goto('/');
  await startScreen(page);
  await expect(page.getByTestId('shared-origin')).toHaveCount(0);
});
