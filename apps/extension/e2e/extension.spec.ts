import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PACKAGE, expect, test } from './fixtures';

const STORAGE_KEY = 'blindvault.extension.confirmed';
const version = readFileSync(join(PACKAGE, 'version.txt'), 'utf8').trim();
const hash = createHash('sha256')
  .update(readFileSync(join(PACKAGE, 'asset-manifest.txt')))
  .digest('hex');

test('opens the app as a device of its own, and records its build on first use', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/index.html`);
  const intro = page.getByTestId('no-server');
  await expect(intro).toContainText('This extension is a separate device of your vault');
  await expect(intro).toContainText('opens no vault until you confirm them');
  // The hash of the package's own asset manifest, which lists manifest.json (D285).
  const recorded = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
  expect(JSON.parse(recorded ?? 'null')).toEqual({ version, hash });
});

test('stops a changed build before any vault, until confirmed (extension.md §8.2)', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  const url = `chrome-extension://${extensionId}/index.html`;
  await page.goto(url);
  await expect(page.getByTestId('no-server')).toBeVisible();
  const previous = { version: '0.9.0', hash: 'a'.repeat(64) };
  await page.evaluate(
    ([key, value]) => {
      localStorage.setItem(key, value);
    },
    [STORAGE_KEY, JSON.stringify(previous)] as const,
  );
  await page.reload();

  const lock = page.getByTestId('version-lock');
  await expect(lock).toBeVisible();
  await expect(page.getByTestId('no-server')).toBeHidden();
  await expect(page.getByTestId('version-lock-previous')).toContainText(previous.hash);
  await expect(page.getByTestId('version-lock-running')).toContainText(hash);
  await expect(page.getByRole('link', { name: /release on GitHub/ })).toHaveAttribute(
    'href',
    `https://github.com/allisson/blindvault/releases/tag/v${version}`,
  );
  await page.getByRole('button', { name: 'Confirm this version' }).click();
  await expect(page.getByTestId('no-server')).toBeVisible();
  const recorded = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
  expect(JSON.parse(recorded ?? 'null')).toEqual({ version, hash });
});

test('registers no service worker of the app (D282)', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/index.html`);
  await expect(page.getByTestId('no-server')).toBeVisible();
  const scripts = await page.evaluate(async () =>
    (await navigator.serviceWorker.getRegistrations()).map((r) => r.active?.scriptURL),
  );
  // The extension's own background.js is the only one: the app's sw.js is the web's.
  expect(scripts).toEqual([`chrome-extension://${extensionId}/background.js`]);
});
