// How tests/fixtures/backups/v1.0.0-rc.4.bvault was made (D310): Playwright drives the PUBLISHED
// v1.0.0-rc.4 Chrome package, downloaded from the GitHub release with its hashes checked against
// asset-manifest-chrome.txt. Fictitious data only. Kept as the record of the fixture and as the
// starting point of the next one; it is not run by CI. Two departures from a session by hand:
// - the package is a copy whose manifest grants host_permissions <all_urls>, as
//   apps/extension/e2e/fixtures.ts `withHosts` does, since Playwright cannot click the permission
//   prompt; the app's code is the published one;
// - rc.4 has no "delete permanently" and purges a trashed item 30 days later: the vault is created
//   with Playwright's clock 31 days back, the tombstone's item trashed, and the clock set back to the
//   real time before a lock and an unlock, whose purge is the app's own.
//
// Run it from a directory where @playwright/test resolves (a copy next to a playwright config, with
// the extension's Playwright), with BLINDVAULT_PACKAGE the unzipped published package and
// BLINDVAULT_OUT the directory that receives the .bvault, the phrase and the passkeys.

/* global chrome -- read in the extension's own page, through page.evaluate */

import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

import { chromium, expect, test } from '@playwright/test';

const PUBLISHED = process.env.BLINDVAULT_PACKAGE;
const OUT = process.env.BLINDVAULT_OUT;
const PKG = join(OUT, 'pkg-hosts');

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';
const EXPORT_PASSWORD = 'orchid-ember-saddle-quiver-mosaic-7391';
const SITE = 'https://site.test';
const DAY = 24 * 60 * 60 * 1000;

/** 200 KiB of fixed pseudo-random bytes: SHA-256 of a counter. */
function fixedBytes(size) {
  const out = Buffer.alloc(size);
  for (let i = 0, off = 0; off < size; i++, off += 32) {
    createHash('sha256').update(`blindvault-frozen-rc4-${i}`).digest().copy(out, off);
  }
  return out;
}

const button = (page, name) => page.getByRole('button', { name, exact: true });

async function createVault(page) {
  const starts = button(page, 'Create a new vault');
  await expect(starts).toBeVisible({ timeout: 60_000 });
  await starts.click();
  await expect(page.getByTestId('recovery-phrase')).toBeVisible();
  const words = [];
  for (let n = 1; n <= 24; n++) {
    words.push(((await page.getByTestId(`phrase-word-${n}`).textContent()) ?? '').trim());
  }
  await button(page, 'I wrote them down').click();
  const fields = page.locator('[data-testid^="confirm-word-"]');
  await expect(fields).toHaveCount(3);
  for (const field of await fields.all()) {
    const n = Number((await field.getAttribute('data-testid')).replace('confirm-word-', ''));
    await field.fill(words[n - 1]);
  }
  await button(page, 'Confirm').click();
  await page.getByTestId('new-password').fill(PASSWORD);
  await page.getByTestId('confirm-password').fill(PASSWORD);
  await button(page, 'Create vault').click();
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 60_000 });
  await button(page, 'Open the vault').click();
  await expect(page.getByTestId('ready')).toHaveCount(0);
  return words;
}

async function openSettings(page, name) {
  await button(page, 'Settings').first().click();
  await page.getByTestId(`settings-${name}`).click();
}

async function closeSettings(page) {
  // Back to the index, then back to the vault.
  while (await button(page, 'Back').isVisible()) await button(page, 'Back').click();
}

async function allItems(page) {
  await closeSettings(page);
  await button(page, 'All items').click();
}

async function newItem(page, template, title, fields) {
  await button(page, 'New item').click();
  await button(page, template).click();
  await page.getByTestId('item-title').fill(title);
  for (const [label, value] of Object.entries(fields)) {
    await page.getByTestId(`input-${label}`).fill(value);
  }
}

async function save(page, title) {
  await button(page, 'Save').click();
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
}

async function lockAndUnlock(page) {
  await button(page, 'Lock').click();
  await page.getByTestId('unlock-password').fill(PASSWORD);
  await button(page, 'Unlock').click();
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 60_000 });
}

/** In the site's page: a create whose only listed algorithm is `alg`. */
async function createPasskey(args) {
  const [alg, userId, name] = args;
  const c = await navigator.credentials.create({
    publicKey: {
      rp: { name: 'Site Test' },
      user: { id: new Uint8Array([userId]), name, displayName: name },
      challenge: new Uint8Array(32).fill(userId),
      pubKeyCredParams: [{ type: 'public-key', alg }],
    },
  });
  return { alg: c.response.getPublicKeyAlgorithm(), id: c.id };
}

test('frozen backup of v1.0.0-rc.4', async () => {
  mkdirSync(OUT, { recursive: true });
  cpSync(PUBLISHED, PKG, { recursive: true });
  const manifestFile = join(PKG, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  writeFileSync(manifestFile, JSON.stringify({ ...manifest, host_permissions: ['<all_urls>'] }));

  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    locale: 'en-US',
    timezoneId: 'UTC',
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
    args: [`--disable-extensions-except=${PKG}`, `--load-extension=${PKG}`],
  });
  const log = [];
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(worker.url()).host;

    // Phase 1, 31 days ago: the item that becomes a purged tombstone (the app purges a trashed item
    // only 30 days after it was trashed, and has no "delete permanently" in rc.4).
    const realNow = Date.now();
    await context.clock.install({ time: realNow - 31 * DAY });

    const page = await context.newPage();
    page.on('console', (m) => log.push(`${m.type()}: ${m.text()}`));
    page.on('pageerror', (e) => log.push(`pageerror: ${String(e)}`));
    await page.goto(`chrome-extension://${extensionId}/index.html`);
    const words = await createVault(page);
    writeFileSync(join(OUT, 'phrase.txt'), words.join(' '));

    await newItem(page, 'Login', 'Old forum account', {
      Username: 'bruno.forum.2219',
      Password: 'Velvet-Comet-8841-Moss',
      Website: 'https://forum.example',
    });
    await save(page, 'Old forum account');
    await button(page, 'More actions').click();
    await button(page, 'Move to trash').click();
    await expect(page.getByRole('heading', { name: 'Old forum account', level: 1 })).toHaveCount(0);

    // Back to the real time: the unlock runs the purge (VaultSession.unlock).
    await context.clock.setSystemTime(Date.now());
    await lockAndUnlock(page);
    await button(page, 'Trash').click();
    await expect(page.getByText('The trash is empty.')).toBeVisible();

    // Settings › Passkeys on.
    await openSettings(page, 'sitePasskeys');
    const sw = page.getByTestId('site-passkeys-switch');
    await expect(sw).toBeVisible();
    if (!(await sw.isChecked())) await sw.check();
    await expect(sw).toBeChecked();
    await expect
      .poll(() =>
        page.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length),
      )
      .toBe(2);
    await closeSettings(page);

    // Nested folders: Work › Clients, with a note holding a 200 KiB attachment.
    await button(page, '+ New folder').click();
    await page.getByTestId('folder-name').fill('Work');
    await button(page, 'Create').click();
    await expect(page.getByRole('heading', { name: 'Work', level: 2 })).toBeVisible();
    await button(page, 'New subfolder').click();
    await page.getByTestId('folder-name').fill('Clients');
    await button(page, 'Create').click();
    await expect(page.getByRole('heading', { name: 'Clients', level: 2 })).toBeVisible();
    await newItem(page, 'Secure note', 'Client contract', {});
    await expect(page.getByTestId('item-folder')).toHaveValue(/.+/);
    const blob = fixedBytes(200 * 1024);
    writeFileSync(join(OUT, 'contract-scan.bin'), blob);
    await page.getByTestId('attachment-input').setInputFiles({
      name: 'contract-scan.bin',
      mimeType: 'application/octet-stream',
      buffer: blob,
    });
    await expect(page.getByTestId('attachment-file')).toHaveText(/^contract-scan\.bin · /);
    await save(page, 'Client contract');

    // One item of every template, at the vault root.
    await allItems(page);
    await newItem(page, 'Login', 'Harbor Credit Union', {
      Username: 'ana.lima.7731',
      Password: 'Tulip-Orbit-5528-Granite',
      Website: 'https://harbor.example',
    });
    await page.getByTestId('item-tags').fill('bank, family');
    await save(page, 'Harbor Credit Union');
    // History: two edits.
    await button(page, 'Edit').click();
    await page.getByTestId('input-Username').fill('ana.lima.0042');
    await save(page, 'Harbor Credit Union');
    await button(page, 'Edit').click();
    await page.getByTestId('input-Password').fill('Granite-Tulip-9917-Orbit');
    await save(page, 'Harbor Credit Union');

    await allItems(page);
    await newItem(page, 'Secure note', 'Garage door code', {});
    await save(page, 'Garage door code');

    await allItems(page);
    await newItem(page, 'Payment card', 'Visa Harbor', {
      Cardholder: 'Ana Lima',
      'Card number': '4111111111111111',
      Expiry: '2029-05',
      'Security code': '123',
      PIN: '4821',
    });
    await save(page, 'Visa Harbor');

    await allItems(page);
    await newItem(page, 'Identity', 'Ana Lima', {
      'First name': 'Ana',
      'Last name': 'Lima',
      'Date of birth': '1988-03-14',
      Email: 'ana.lima@example.com',
      Phone: '+55 11 5555-0100',
      Address: 'Rua Exemplo, 100\nSão Paulo',
    });
    await save(page, 'Ana Lima');

    await allItems(page);
    await newItem(page, 'Developer credential', 'Example API key', {
      Provider: 'Example Cloud',
      'Base URL': 'https://api.example.dev',
      'Key ID': 'AKEXAMPLE0001',
      Secret: 'sk_example_6f1e2d3c4b5a69788796a5b4c3d2e1f0',
    });
    await save(page, 'Example API key');

    await allItems(page);
    await newItem(page, 'Crypto wallet', 'Cold wallet', {
      'Wallet name': 'Cold storage',
      Network: 'Bitcoin',
      'Seed phrase':
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      Passphrase: 'Lantern-Quiver-2290',
      'Derivation path': "m/84'/0'/0'",
      'Wallet address': 'bc1qexampleaddress0000000000000000000000',
    });
    await save(page, 'Cold wallet');

    await allItems(page);
    await newItem(page, 'Document', 'Passport', {
      'Document type': 'Passport',
      'Document number': 'XY123456',
      'Full name': 'Ana Lima',
      Issuer: 'Example Republic',
      'Issue date': '2020-01-15',
      'Expiry date': '2030-01-14',
    });
    await save(page, 'Passport');

    // An item left in the trash.
    await allItems(page);
    await newItem(page, 'Login', 'Retired mail account', {
      Username: 'ana.old@example.net',
      Password: 'Moss-Harbor-3318-Velvet',
      Website: 'https://mail.example.net',
    });
    await save(page, 'Retired mail account');
    await button(page, 'More actions').click();
    await button(page, 'Move to trash').click();
    await expect(page.getByRole('heading', { name: 'Retired mail account', level: 1 })).toHaveCount(
      0,
    );

    // Passkeys through the extension: ES256 only, then EdDSA only.
    await context.route(/^https:\/\/site\.test\//, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>site</title><p>site</p>',
      }),
    );
    const site = await context.newPage();
    await site.goto(`${SITE}/login`);
    const passkeys = [];
    for (const [alg, userId, name] of [
      [-7, 11, 'es256@site.test'],
      [-8, 12, 'eddsa@site.test'],
    ]) {
      const window = context.waitForEvent('page', (p) => p.url().includes('/confirm.html#'));
      const creating = site.evaluate(createPasskey, [alg, userId, name]);
      const confirm = await window;
      await expect(confirm.getByText(name)).toBeVisible();
      await confirm.getByTestId('confirm-save').click();
      const created = await creating;
      expect(created.alg).toBe(alg);
      passkeys.push({ name, ...created });
    }
    writeFileSync(join(OUT, 'passkeys.json'), JSON.stringify(passkeys, null, 2));
    await site.close();

    // Export with an export password.
    await page.bringToFront();
    await openSettings(page, 'backup');
    await page.getByTestId('backup-protect').check();
    await page.getByTestId('export-password').fill(EXPORT_PASSWORD);
    await page.getByTestId('export-confirm').fill(EXPORT_PASSWORD);
    await page.getByTestId('backup-password').fill(PASSWORD);
    await expect(button(page, 'Export')).toBeEnabled();
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 180_000 }),
      button(page, 'Export').click(),
    ]);
    copyFileSync(await download.path(), join(OUT, 'v1.0.0-rc.4.bvault'));
    writeFileSync(join(OUT, 'export-name.txt'), download.suggestedFilename());
    await expect(page.getByRole('main').getByRole('status')).toHaveText(/^Backup exported\./);
  } finally {
    writeFileSync(join(OUT, 'console.log'), log.join('\n'));
    await context.close();
  }
});
