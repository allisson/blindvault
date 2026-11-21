import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type BrowserContext, type Worker, test as base, chromium } from '@playwright/test';

export const PACKAGE = fileURLToPath(new URL('../dist/chrome', import.meta.url));

/**
 * A copy of the package, for tests only, whose manifest grants `hosts` (D287): Playwright cannot
 * click the toolbar or press a command, the gestures that grant `activeTab`, so the copy holds the
 * host permission the gesture would. The released package has none.
 */
export function withHosts(hosts: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'blindvault-extension-'));
  cpSync(PACKAGE, dir, { recursive: true });
  const file = join(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...manifest, host_permissions: hosts }));
  return dir;
}

/** A Chromium profile with the extension loaded, its service worker and the extension's ID. */
export const test = base.extend<{
  /** The unpacked package the profile loads. */
  extensionPackage: string;
  context: BrowserContext;
  worker: Worker;
  extensionId: string;
}>({
  extensionPackage: [PACKAGE, { option: true }],
  context: async ({ extensionPackage }, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [
        `--disable-extensions-except=${extensionPackage}`,
        `--load-extension=${extensionPackage}`,
      ],
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
