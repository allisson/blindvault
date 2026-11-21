// Filling from the session host (extension.md §6, D283, D287), on Chromium with a test copy of the
// package granting the test sites (`withHosts`): Playwright cannot make the gesture that grants
// `activeTab`. The messages come from the extension's own pages, the popup's and the service
// worker's, as the toolbar and the shortcut would send them. The page side of filling also runs in
// Firefox and WebKit, in apps/web/e2e/extension-fill.spec.ts.

import { type BrowserContext, type Page, type Worker } from '@playwright/test';

import { createVault } from '../../web/e2e/create.ts';
import { expect, test, withHosts } from './fixtures';

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';
const SECRET = 'Tulip-Orbit-5528-Granite';
const SITE = 'https://site.test';
const ADS = 'https://ads.test';

test.use({ extensionPackage: withHosts([`${SITE}/*`, `${ADS}/*`]) });

async function newLogin(host: Page, title: string, website: string): Promise<void> {
  await host.getByRole('button', { name: 'New item', exact: true }).click();
  await host.getByRole('button', { name: 'Login', exact: true }).click();
  await host.getByTestId('item-title').fill(title);
  await host.getByTestId('input-Username').fill('ana.lima');
  await host.getByTestId('input-Password').fill(SECRET);
  await host.getByTestId('input-Website').fill(website);
  await host.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(host.getByRole('heading', { name: title })).toBeVisible();
}

/** A sign-in page, with an ad's iframe of another origin whose password field has the focus. */
async function site(context: BrowserContext): Promise<Page> {
  await context.route(/^https:\/\/(site|ads)\.test\//, (route) => {
    const url = route.request().url();
    const body = url.startsWith(ADS)
      ? '<input name="trap" type="password" autofocus>'
      : `<script>
           window.seen = [];
           addEventListener('submit', (e) => { seen.push('submit'); e.preventDefault(); }, true);
         </script>
         <form><input name="email" type="email"><input name="pass" type="password"></form>
         <iframe src="${ADS}/ad"></iframe>`;
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html>${body}` });
  });
  const page = await context.newPage();
  await page.goto(`${SITE}/login`);
  return page;
}

async function popupPage(context: BrowserContext, extensionId: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.getByTestId('popup')).toBeVisible();
  return page;
}

type Answer = Record<string, unknown>;

/** Runs in the extension's page or worker. */
const sendMessage = (m: object): Promise<Answer> =>
  (
    globalThis as unknown as {
      chrome: { runtime: { sendMessage(m: object): Promise<Answer> } };
    }
  ).chrome.runtime.sendMessage(m);

/** Sends one message from an extension page, as the popup or the service worker does. */
function send(from: Page | Worker, message: object): Promise<Answer> {
  return 'goto' in from ? from.evaluate(sendMessage, message) : from.evaluate(sendMessage, message);
}

/** The site's tab, which the test copy of the package may read. */
async function siteTab(from: Page): Promise<number> {
  const id = await from.evaluate(async (site) => {
    const api = (
      globalThis as unknown as {
        chrome: { tabs: { query(q: object): Promise<{ id?: number; url?: string }[]> } };
      }
    ).chrome;
    return (await api.tabs.query({})).find((t) => t.url?.startsWith(site))?.id;
  }, SITE);
  if (id === undefined) throw new Error('no site tab');
  return id;
}

async function itemId(popup: Page, query: string): Promise<string> {
  const answer = await send(popup, { v: 1, type: 'search', id: 1, query });
  const [item] = answer.items as { itemId: string }[];
  if (!item) throw new Error(`no item for ${query}`);
  return item.itemId;
}

test('fills the matching item into the top frame, never the cross-origin iframe, and never submits', async ({
  context,
  extensionId,
}) => {
  test.setTimeout(120_000);
  const host = await context.newPage();
  await host.goto(`chrome-extension://${extensionId}/index.html`);
  await createVault(host, PASSWORD);
  await newLogin(host, 'Site', `${SITE}/login`);
  await newLogin(host, 'Elsewhere', 'https://other.test');
  const page = await site(context);
  const ad = page.frames().find((f) => f.url().startsWith(ADS));
  await ad?.locator('[name=trap]').focus();

  const popup = await popupPage(context, extensionId);
  const tabId = await siteTab(popup);
  const matches = await send(popup, { v: 1, type: 'matches', id: 2, tabId });
  expect(matches).toMatchObject({
    ok: true,
    items: [{ title: 'Site', username: 'ana.lima', url: `${SITE}/login` }],
  });
  // No secret travels in the list (D132).
  expect(JSON.stringify(matches)).not.toContain(SECRET);

  const elsewhere = await itemId(popup, 'Elsewhere');
  await expect(
    send(popup, { v: 1, type: 'fill', id: 3, tabId, itemId: elsewhere }),
  ).resolves.toEqual({ v: 1, id: 3, ok: false, error: 'no-match' });
  await expect(page.locator('[name=pass]')).toHaveValue('');

  const siteItem = await itemId(popup, 'Site');
  await expect(
    send(popup, { v: 1, type: 'fill', id: 4, tabId, itemId: siteItem }),
  ).resolves.toEqual({ v: 1, id: 4, ok: true });
  await expect(page.locator('[name=email]')).toHaveValue('ana.lima');
  await expect(page.locator('[name=pass]')).toHaveValue(SECRET);
  await expect(ad?.locator('[name=trap]') ?? page.locator('none')).toHaveValue('');
  expect(await page.evaluate(() => (window as unknown as { seen: string[] }).seen)).toEqual([]);
  await expect(page).toHaveURL(`${SITE}/login`);
});

test('the shortcut fills the one matching item, and the popup is asked otherwise', async ({
  context,
  worker,
  extensionId,
}) => {
  test.setTimeout(120_000);
  const host = await context.newPage();
  await host.goto(`chrome-extension://${extensionId}/index.html`);
  await createVault(host, PASSWORD);
  await newLogin(host, 'Site', `${SITE}/login`);
  const page = await site(context);
  const popup = await popupPage(context, extensionId);
  const tabId = await siteTab(popup);

  // As the service worker sends it on the `fill` command.
  await expect(send(worker, { v: 1, type: 'command-fill', id: 0, tabId })).resolves.toEqual({
    v: 1,
    id: 0,
    ok: true,
    result: 'filled',
  });
  await expect(page.locator('[name=pass]')).toHaveValue(SECRET);
  // The popup may not send it.
  await expect(send(popup, { v: 1, type: 'command-fill', id: 1, tabId })).resolves.toEqual({
    v: 1,
    id: 1,
    ok: false,
    error: 'invalid',
  });

  await newLogin(host, 'Site again', `${SITE}/`);
  await expect(send(worker, { v: 1, type: 'command-fill', id: 0, tabId })).resolves.toMatchObject({
    result: 'popup',
  });
});

test('the popup over a page that cannot match says so', async ({ context, extensionId }) => {
  const host = await context.newPage();
  await host.goto(`chrome-extension://${extensionId}/index.html`);
  await createVault(host, PASSWORD);
  // Opened as a tab, the popup's active tab is its own extension page.
  const popup = await popupPage(context, extensionId);
  await expect(popup.getByText('This page cannot be filled')).toBeVisible();
  await expect(popup.getByRole('button', { name: 'Fill', exact: true })).toHaveCount(0);
});
