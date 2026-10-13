import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';

import { type Page, expect, test } from '@playwright/test';

import { MANIFEST, writeManifest } from '../build/asset-manifest';
import { createVault } from './create';

// Calibrating Argon2id targets about 1 s per derivation (D9).
test.setTimeout(180_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';
const DIST = new URL('../dist/', import.meta.url).pathname;

const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.txt': 'text/plain',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

/** A static host whose deployment the test switches, as a new release would. */
class Host {
  root = '';
  #server: Server | undefined;
  url = '';

  async start(): Promise<void> {
    this.#server = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://host').pathname;
      const file = normalize(join(this.root, path === '/' ? 'index.html' : path));
      readFile(file).then(
        (body) => {
          response.writeHead(200, {
            'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
            'cache-control': 'no-cache',
          });
          response.end(body);
        },
        () => {
          response.writeHead(404).end();
        },
      );
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, 'localhost', resolve));
    const address = this.#server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    this.url = `http://localhost:${String(address.port)}/`;
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.#server?.close(resolve));
  }
}

let work = '';
const host = new Host();

/** A deployment derived from the build: another version, maybe a changed sw.js or a bad file. */
async function deploy(
  name: string,
  change: { version?: string; worker?: boolean; tamper?: boolean } = {},
): Promise<{ root: string; hash: string }> {
  const root = join(work, name);
  await cp(DIST, root, { recursive: true });
  if (change.version) {
    await writeFile(join(root, 'version.txt'), `${change.version}\n`);
    const index = join(root, 'index.html');
    const html = await readFile(index, 'utf8');
    await writeFile(
      index,
      html.replace('<head>', `<head><meta name="e2e-deploy" content="${change.version}">`),
    );
  }
  if (change.worker) {
    // sw.js is not listed: the browser updates it on its own (D63).
    await writeFile(
      join(root, 'sw.js'),
      `${await readFile(join(root, 'sw.js'), 'utf8')}\n// next\n`,
    );
  }
  await writeManifest(root);
  if (change.tamper) await writeFile(join(root, 'icon.svg'), '<svg/>');
  const manifest = await readFile(join(root, MANIFEST));
  return { root, hash: createHash('sha256').update(manifest).digest('hex') };
}

test.beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'blindvault-update-'));
  await host.start();
});

test.afterAll(async () => {
  await host.stop();
  await rm(work, { recursive: true, force: true });
});

/** Opens the app under its service worker, which serves it from the cache from then on. */
async function openControlled(page: Page): Promise<void> {
  await page.goto(host.url);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
}

/** The app comes back into view: it looks for a changed sw.js and an asset update (D162). */
async function becomeVisible(page: Page): Promise<void> {
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
}

async function servedDeploy(page: Page): Promise<string | null> {
  return page
    .locator('meta[name="e2e-deploy"]')
    .getAttribute('content', { timeout: 1_000 })
    .catch(() => null);
}

async function unlock(page: Page): Promise<void> {
  await page.getByTestId('unlock-password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });
}

test('offers a new deploy without switching to it, and switches only once confirmed (D63, D152, D191)', async ({
  page,
}) => {
  host.root = (await deploy('first')).root;
  await openControlled(page);
  await createVault(page, PASSWORD);

  const next = await deploy('next', { version: '0.0.1-next' });
  host.root = next.root;
  await becomeVisible(page);
  const banner = page.getByTestId('update-banner');
  await expect(banner).toContainText('An update is available: version 0.0.0 → 0.0.1-next.', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('update-hash')).toHaveText(next.hash);
  // Being offered locks nothing.
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked');

  // Without confirmation the running version stays, reload after reload.
  for (let n = 0; n < 2; n++) {
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Unlock the vault' })).toBeVisible();
    expect(await servedDeploy(page)).toBeNull();
    expect(await page.evaluate(async () => (await fetch('/version.txt')).text())).toBe('0.0.0\n');
  }
  await expect(page.getByTestId('update-hash')).toHaveText(next.hash, { timeout: 30_000 });

  await unlock(page);
  await expect(page.getByTestId('update-hash')).toHaveText(next.hash, { timeout: 30_000 });
  await page.getByRole('button', { name: 'Update and lock', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Unlock the vault' })).toBeVisible({
    timeout: 30_000,
  });
  await expect.poll(() => servedDeploy(page)).toBe('0.0.1-next');
  expect(await page.evaluate(async () => (await fetch('/version.txt')).text())).toBe(
    '0.0.1-next\n',
  );
  await expect(page.getByTestId('update-banner')).toHaveCount(0);
  await unlock(page);
});

test('does not offer a deploy whose files fail their hashes (D191)', async ({ page }) => {
  host.root = (await deploy('first')).root;
  await openControlled(page);
  host.root = (await deploy('tampered', { version: '0.0.2-bad', tamper: true })).root;
  const reply = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = ({ data }) => {
          resolve(data);
        };
        navigator.serviceWorker.controller?.postMessage({ type: 'check' }, [channel.port2]);
      }),
  );
  expect(reply).toEqual({ type: 'none' });
  await becomeVisible(page);
  await expect(page.getByRole('button', { name: 'Create a new vault' })).toBeVisible();
  await expect(page.getByTestId('update-banner')).toHaveCount(0);
});

test('locks an unlocked vault and warns when the host serves a changed sw.js (D63, D142, D162, D191)', async ({
  page,
}) => {
  host.root = (await deploy('first')).root;
  await openControlled(page);
  await createVault(page, PASSWORD);

  host.root = (await deploy('worker', { version: '0.0.3-worker', worker: true })).root;
  await becomeVisible(page);
  const warning = page.getByTestId('changed-worker');
  await expect(warning).toContainText('The host served a changed service worker', {
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'I verified, continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Unlock the vault' })).toBeVisible();
  // The new bundle came with the changed worker: no asset update is offered next to it.
  await expect(page.getByTestId('update-banner')).toHaveCount(0);

  // The warning comes back at every start while the new worker waits.
  await page.reload();
  await expect(warning).toBeVisible({ timeout: 30_000 });
});
