import { type Page, expect, test } from '@playwright/test';

import { HEADER_CSP } from '../build/csp';
import { startScreen } from './create';

// Runs only against a self-hosted server with a configuration of deploy/ (playwright.self-hosting
// .config.ts, docs/self-hosting.md, D195): the preview server of the main suite sends no headers.

/** The address of the same server under another origin and another site, still a secure context. */
function outside(origin: string): string {
  return origin.replace('//localhost:', '//127.0.0.1:');
}

async function allowLoopback(page: Page, browserName: string): Promise<void> {
  // Chromium's Local Network Access treats a routed page, which has no address, as public.
  if (browserName === 'chromium') await page.context().grantPermissions(['local-network-access']);
}

test('sends the security headers with every response (D83, D147, D193, D195)', async ({
  request,
}) => {
  const manifest = await (await request.get('/asset-manifest.txt')).text();
  const asset = manifest.split('\n').find((line) => line.slice(66).startsWith('assets/'));
  expect(asset).toBeDefined();
  for (const path of ['/', '/sw.js', '/asset-manifest.txt', `/${asset?.slice(66) ?? ''}`]) {
    const headers = (await request.get(path)).headers();
    expect(headers['content-security-policy'], path).toBe(HEADER_CSP);
    expect(headers['referrer-policy'], path).toBe('no-referrer');
    expect(headers['x-content-type-options'], path).toBe('nosniff');
    expect(headers['cross-origin-opener-policy'], path).toBe('same-origin');
  }
});

test('has files whose name does not change checked at every load, and hashed ones kept (D63, D195)', async ({
  request,
}) => {
  for (const path of [
    '/',
    '/index.html',
    '/sw.js',
    '/asset-manifest.txt',
    '/version.txt',
    '/manifest.webmanifest',
  ]) {
    expect((await request.get(path)).headers()['cache-control'], path).toContain('no-cache');
  }
  const manifest = await (await request.get('/asset-manifest.txt')).text();
  const asset = manifest.split('\n').find((line) => line.slice(66).startsWith('assets/'));
  const cached = (await request.get(`/${asset?.slice(66) ?? ''}`)).headers()['cache-control'] ?? '';
  expect(cached).not.toContain('no-cache');
  expect(cached).toMatch(/max-age=\d{7,}/);
});

test('serves scripts and the web app manifest with their types (D190, D195)', async ({
  request,
}) => {
  const types = {
    '/sw.js': /^(text|application)\/javascript\b/,
    '/manifest.webmanifest': /^application\/manifest\+json\b/,
    '/': /^text\/html\b/,
    '/asset-manifest.txt': /^text\/plain\b/,
  };
  for (const [path, type] of Object.entries(types)) {
    expect((await request.get(path)).headers()['content-type'], path).toMatch(type);
  }
});

test('cannot be framed by another origin: frame-ancestors stops the load (D193, D195)', async ({
  page,
  baseURL,
  browserName,
}) => {
  const origin = baseURL ?? '';
  await allowLoopback(page, browserName);
  const framer = `${outside(origin)}/framer.html`;
  await page.route(framer, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><iframe src="${origin}/" width="600" height="600"></iframe>`,
    }),
  );
  const blocked = page.waitForEvent('response', (r) => r.url() === `${origin}/`);
  await page.goto(framer);
  expect((await blocked).headers()['content-security-policy']).toBe(HEADER_CSP);
  // Give a loaded app every chance to render, then require it never did.
  await page.waitForTimeout(2_000);
  const app = page.frameLocator('iframe');
  await expect(app.getByTestId('framed')).toHaveCount(0);
  await expect(app.getByRole('button')).toHaveCount(0);
  await expect(app.locator('#root')).toHaveCount(0);
});

test('keeps no handle for a page of another origin that opens it (D195)', async ({
  page,
  baseURL,
  browserName,
}) => {
  const origin = baseURL ?? '';
  await allowLoopback(page, browserName);
  const opener = `${outside(origin)}/opener.html`;
  await page.route(opener, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>opener</title>' }),
  );
  await page.goto(opener);
  const popup = page.waitForEvent('popup');
  await page.evaluate((url) => {
    (window as unknown as { opened: Window | null }).opened = window.open(url);
  }, `${origin}/`);
  const app = await popup;
  await startScreen(app);
  // Cross-Origin-Opener-Policy put the app in another browsing context group: the opener's handle
  // is closed, and the app has no opener.
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { opened: Window | null }).opened?.closed),
    )
    .toBe(true);
  expect(await app.evaluate(() => window.opener === null)).toBe(true);
});
