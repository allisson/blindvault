import { type Frame, type Page, expect, test } from '@playwright/test';

import { createVault } from './create';

// Under §11 (D83, D193) the app does not open inside a frame: no start screen, no vault database
// opened, no Web Lock, no worker, no asset manifest and no service worker.

/** Requests the app makes only once it starts: the manifest, the service worker, the Argon2id
 * worker and the strength dictionaries (D142, D191, D192). */
const STARTUP = /\/asset-manifest\.txt$|\/sw\.js$|\/assets\/kdf\.worker-|\/assets\/index\.esm-/;

function framer(src: string): string {
  return `<!doctype html><title>framer</title><iframe src="${src}" width="600" height="600"></iframe>`;
}

async function appFrame(page: Page, origin: string): Promise<Frame> {
  await expect
    .poll(() => page.frames().find((f) => f !== page.mainFrame() && f.url().startsWith(origin)))
    .toBeTruthy();
  const frame = page.frames().find((f) => f !== page.mainFrame() && f.url().startsWith(origin));
  if (!frame) throw new Error('no app frame');
  return frame;
}

async function expectRefused(page: Page, frame: Frame, origin: string): Promise<void> {
  const app = page.frameLocator('iframe');
  await expect(app.getByTestId('framed')).toBeVisible();
  await expect(app.getByTestId('framed')).toContainText(
    'BlindVault does not open inside another page',
  );
  const link = app.getByRole('link', { name: 'Open BlindVault in its own tab' });
  await expect(link).toHaveAttribute('href', `${origin}/`);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(app.locator('input')).toHaveCount(0);
  await expect(app.getByRole('button')).toHaveCount(0);
  const held = await frame.evaluate(async () => (await navigator.locks.query()).held ?? []);
  expect(held).toEqual([]);
}

test('does not open inside a frame of another origin (D83, D193)', async ({
  page,
  context,
  baseURL,
  browserName,
}) => {
  const origin = baseURL ?? '';
  // Chromium's Local Network Access treats the routed page, which has no address, as public, and
  // blocks a public page from framing a loopback one unless allowed.
  if (browserName === 'chromium') await context.grantPermissions(['local-network-access']);
  const startup: string[] = [];
  page.on('request', (r) => {
    if (STARTUP.test(new URL(r.url()).pathname)) startup.push(r.url());
  });
  // Another origin and another site, still a secure context, so the frame has every API it would
  // have on its own.
  const outside = `${origin.replace('//localhost:', '//127.0.0.1:')}/framer.html`;
  expect(outside).not.toBe(`${origin}/framer.html`);
  await page.route(outside, (route) =>
    route.fulfill({ contentType: 'text/html', body: framer(`${origin}/`) }),
  );
  await page.goto(outside);
  const frame = await appFrame(page, origin);
  await expectRefused(page, frame, origin);
  const state = await frame.evaluate(async () => ({
    databases: (await indexedDB.databases()).map((d) => d.name),
    workers: (await navigator.serviceWorker.getRegistrations()).length,
  }));
  expect(state).toEqual({ databases: [], workers: 0 });
  expect(startup).toEqual([]);
});

test.describe('in a frame of its own origin', () => {
  // page.route sees no request a service worker answers, and the framing page is routed.
  test.use({ serviceWorkers: 'block' });

  test('does not open, with a vault already created (D83, D193)', async ({ page, baseURL }) => {
    const origin = baseURL ?? '';
    await page.goto('/');
    await createVault(page, 'framed-app correct horse battery');
    await page.route(`${origin}/framer.html`, (route) =>
      route.fulfill({ contentType: 'text/html', body: framer('/') }),
    );
    const startup: string[] = [];
    page.on('request', (r) => {
      if (STARTUP.test(new URL(r.url()).pathname)) startup.push(r.url());
    });
    await page.goto('/framer.html');
    const frame = await appFrame(page, origin);
    await expectRefused(page, frame, origin);
    // The frame shares the vault's storage partition: the vault is there, and stays closed.
    const databases = await frame.evaluate(async () =>
      (await indexedDB.databases()).map((d) => d.name ?? ''),
    );
    expect(databases.some((name) => name.startsWith('blindvault-'))).toBe(true);
    expect(startup).toEqual([]);
  });
});
