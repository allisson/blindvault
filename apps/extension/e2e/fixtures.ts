import { fileURLToPath } from 'node:url';

import { type BrowserContext, type Worker, test as base, chromium } from '@playwright/test';

export const PACKAGE = fileURLToPath(new URL('../dist/chrome', import.meta.url));

/** A Chromium profile with the extension loaded, its service worker and the extension's ID. */
export const test = base.extend<{
  context: BrowserContext;
  worker: Worker;
  extensionId: string;
}>({
  // eslint-disable-next-line no-empty-pattern -- Playwright reads the fixtures from the pattern.
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [`--disable-extensions-except=${PACKAGE}`, `--load-extension=${PACKAGE}`],
    });
    await use(context);
    await context.close();
  },
  /** The extension's service worker, `background.js`. */
  worker: async ({ context }, use) => {
    await use(context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker')));
  },
  extensionId: async ({ worker }, use) => {
    await use(new URL(worker.url()).host);
  },
});

export { expect } from '@playwright/test';
