import { fileURLToPath } from 'node:url';

import { type BrowserContext, test as base, chromium } from '@playwright/test';

export const PACKAGE = fileURLToPath(new URL('../dist/chrome', import.meta.url));

/** A Chromium profile with the extension loaded, and the extension's ID. */
export const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright reads the fixtures from the pattern.
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [`--disable-extensions-except=${PACKAGE}`, `--load-extension=${PACKAGE}`],
    });
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await use(new URL(worker.url()).host);
  },
});

export { expect } from '@playwright/test';
