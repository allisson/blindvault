import { expect, test } from '@playwright/test';

import { createVault } from './create';

// Calibrating Argon2id targets about 1 s per derivation (D9).
test.setTimeout(120_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';

test('declares the app installable, with icons the asset manifest lists (D190)', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    'href',
    '/manifest.webmanifest',
  );
  const manifest = (await (await request.get('/manifest.webmanifest')).json()) as {
    name: string;
    start_url: string;
    scope: string;
    display: string;
    icons: { src: string; sizes: string; purpose?: string }[];
  };
  expect(manifest).toMatchObject({
    name: 'BlindVault',
    start_url: '/',
    scope: '/',
    display: 'standalone',
  });
  const listed = (await (await request.get('/asset-manifest.txt')).text())
    .trim()
    .split('\n')
    .map((line) => line.slice(66));
  expect(listed).toContain('manifest.webmanifest');
  const touch = (await page.locator('link[rel="apple-touch-icon"]').getAttribute('href')) ?? '';
  const pngs = [
    ...manifest.icons.filter((i) => i.sizes !== 'any'),
    { src: touch, sizes: '180x180' },
  ];
  for (const icon of [...manifest.icons, { src: touch, sizes: 'any' }]) {
    expect(listed).toContain(icon.src.slice(1));
  }
  expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
  for (const icon of pngs) {
    const body = await (await request.get(icon.src)).body();
    // PNG width and height, from the IHDR chunk.
    const side = `${String(body.readUInt32BE(16))}x${String(body.readUInt32BE(20))}`;
    expect(side, icon.src).toBe(icon.sizes);
  }
});

test('serves the listed files from its versioned cache, not the network (D190)', async ({
  page,
}) => {
  await page.goto('/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  // Replace a cached file by a marker: only a worker answering from the cache can serve it.
  const answered = await page.evaluate(async () => {
    const name = (await caches.keys()).find((k) => /^blindvault-[0-9a-f]{64}$/.test(k)) ?? '';
    const cache = await caches.open(name);
    await cache.put(new URL('/icon.svg', location.href).href, new Response('from the cache'));
    const listed = await (await fetch('/icon.svg')).text();
    return { name, listed };
  });
  expect(answered.name).toMatch(/^blindvault-[0-9a-f]{64}$/);
  expect(answered.listed).toBe('from the cache');
});

test('works offline once the service worker has installed (D5, D190)', async ({
  page,
  context,
  browserName,
}) => {
  test.skip(
    browserName === 'webkit',
    "Playwright's WebKit offline emulation fails requests before the service worker: a cached file fails offline (measured); the cache test above covers WebKit.",
  );
  await page.goto('/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // The first load stays on the network (no clients.claim); the next one is served by the worker.
  await page.reload();
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

  await context.setOffline(true);
  await page.reload();
  // Creating a vault loads the Argon2id worker and its WebAssembly: from the cache.
  await createVault(page, PASSWORD);
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked');
  await context.setOffline(false);
});
