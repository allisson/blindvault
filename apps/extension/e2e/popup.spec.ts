// The popup and the session host (extension.md §3, §4, §6.3, D283, D286), on Chromium with the
// unpacked package. The popup is opened as a tab of its page: Playwright cannot click the toolbar.

import { type BrowserContext, type Page, type Worker } from '@playwright/test';

import { createVault, openSettingsPage } from '../../web/e2e/create.ts';
import { expect, test } from './fixtures';

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';
const SECRET = 'Tulip-Orbit-5528-Granite';

async function sessionHost(context: BrowserContext, extensionId: string): Promise<Page> {
  const host = await context.newPage();
  await host.goto(`chrome-extension://${extensionId}/index.html`);
  await createVault(host, PASSWORD);
  return host;
}

async function newLogin(host: Page): Promise<void> {
  await host.getByRole('button', { name: 'New item', exact: true }).click();
  await host.getByRole('button', { name: 'Login', exact: true }).click();
  await host.getByTestId('item-title').fill('Harbor Credit Union');
  await host.getByTestId('input-Username').fill('ana.lima');
  await host.getByTestId('input-Password').fill(SECRET);
  await host.getByTestId('input-Website').fill('https://bank.example/login');
  await host.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(host.getByRole('heading', { name: 'Harbor Credit Union' })).toBeVisible();
}

async function popup(context: BrowserContext, extensionId: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.getByTestId('popup')).toBeVisible();
  return page;
}

/** A web page where the test reads the clipboard: an extension's origin cannot be granted it. */
const READER = 'https://clipboard.test/';

async function clipboardReader(context: BrowserContext): Promise<Page> {
  await context.grantPermissions(['clipboard-read'], { origin: READER });
  await context.route(READER, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>reader</title>' }),
  );
  const reader = await context.newPage();
  await reader.goto(READER);
  return reader;
}

async function clipboard(reader: Page): Promise<string> {
  await reader.bringToFront();
  return reader.evaluate(() => navigator.clipboard.readText());
}

/** Whether the session host's tab is pinned; the service worker reads no tab's URL. */
async function hostPinned(worker: Worker): Promise<boolean> {
  return worker.evaluate(async () => {
    interface Api {
      runtime: {
        getURL(path: string): string;
        getContexts(f: object): Promise<{ documentUrl?: string; tabId: number }[]>;
      };
      tabs: { query(q: object): Promise<{ id?: number }[]> };
    }
    const api = (globalThis as unknown as { chrome: Api }).chrome;
    const url = api.runtime.getURL('index.html');
    const host = (await api.runtime.getContexts({ contextTypes: ['TAB'] })).find(
      (c) => c.documentUrl === url,
    );
    const pinned = await api.tabs.query({ pinned: true });
    return host !== undefined && pinned.some((t) => t.id === host.tabId);
  });
}

test('with no session host, the popup shows the vault locked and opens one, pinned', async ({
  context,
  worker,
  extensionId,
}) => {
  const page = await popup(context, extensionId);
  await expect(page.getByText('BlindVault is locked.')).toBeVisible();
  await expect(page.getByRole('searchbox')).toHaveCount(0);
  const opened = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Open BlindVault', exact: true }).click();
  const host = await opened;
  await expect(host).toHaveURL(`chrome-extension://${extensionId}/index.html`);
  await expect.poll(() => hostPinned(worker)).toBe(true);
});

test('searches the Login items and copies a password, which the session host clears (§6.3)', async ({
  context,
  extensionId,
}) => {
  test.setTimeout(120_000);
  const reader = await clipboardReader(context);
  const host = await sessionHost(context, extensionId);
  await openSettingsPage(host, 'locking');
  await host.getByTestId('clipboardClearSeconds').fill('10');
  await host.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(host.getByText('Saved.', { exact: true })).toBeVisible();
  await host.getByRole('button', { name: 'Back', exact: true }).click();
  await host.getByRole('button', { name: 'Back', exact: true }).click();
  await newLogin(host);

  const page = await popup(context, extensionId);
  const items = page.getByTestId('popup-items');
  await expect(items.getByText('Harbor Credit Union')).toBeVisible();
  // No secret travels in the list (D132, D286).
  expect(await page.content()).not.toContain(SECRET);
  await page.getByRole('searchbox', { name: 'Search logins' }).fill('nothing here');
  await expect(page.getByText('No login found.')).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search logins' }).fill('bank.example ana');
  await expect(items.getByText('ana.lima')).toBeVisible();
  // A search never reads a secret.
  await page.getByRole('searchbox', { name: 'Search logins' }).fill(SECRET);
  await expect(page.getByText('No login found.')).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search logins' }).fill('harbor');

  await items.getByRole('button', { name: 'Copy password', exact: true }).click();
  await expect(
    page.getByText(/clear the clipboard in 10 s; clearing is not guaranteed/),
  ).toBeVisible();
  expect(await clipboard(reader)).toBe(SECRET);
  // The clear runs in the offscreen document, with no page of the extension in front.
  await expect.poll(() => clipboard(reader), { timeout: 20_000 }).toBe('');
  await expect(host.getByTestId('lock-state')).toHaveText('Unlocked');
});

test('the popup’s Lock locks the session host, and the popup then shows it locked', async ({
  context,
  extensionId,
}) => {
  const host = await sessionHost(context, extensionId);
  const page = await popup(context, extensionId);
  // Focused on opening, to search at once.
  await expect(page.getByRole('searchbox', { name: 'Search logins' })).toBeFocused();
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await expect(host.getByTestId('lock-state')).toHaveText('Locked');
  const again = await popup(context, extensionId);
  await expect(again.getByText('BlindVault is locked.')).toBeVisible();
});

test('a second tab of the app leaves the answers to the session host (§3.1)', async ({
  context,
  extensionId,
}) => {
  const host = await sessionHost(context, extensionId);
  const second = await context.newPage();
  await second.goto(`chrome-extension://${extensionId}/index.html`);
  await expect(second.getByTestId('lock-state')).toHaveCount(0);
  const page = await popup(context, extensionId);
  await expect(page.getByRole('searchbox', { name: 'Search logins' })).toBeVisible();
  await expect(host.getByTestId('lock-state')).toHaveText('Unlocked');
});
