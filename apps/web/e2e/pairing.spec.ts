import { type Browser, type Page, expect, test } from '@playwright/test';

import { createVault, openVault, startScreen } from './create';
import { PAIRING_URL } from '../playwright.config';
import { fillPassword } from './password';

// A pairing between two installations, each in its own browser context, through the screens alone
// (§8.4, D202, D203): the texts copied and pasted, the same network only (no STUN server), the SAS
// compared and confirmed on both, then B holds the vault.

// Creation, A's password again and B's password each run Argon2id at about 1 s (D9).
test.setTimeout(240_000);

test.beforeEach(({ browserName }) => {
  // Copy/paste with no camera: both sides send only mDNS names, which WebKit does not connect on
  // the Linux runner (architecture.md). It joins with the QR task, when B holds the camera (D203).
  test.skip(
    browserName === 'webkit' && process.platform === 'linux',
    'WebKit on Linux does not connect over mDNS names only',
  );
});

// Firefox gathers no ICE candidate on `localhost`: this spec runs on 127.0.0.1 (playwright.config.ts).
test.use({ baseURL: PAIRING_URL });

const PASSWORD_A = 'quartz-lantern-velvet-harbor-9214';
const PASSWORD_B = 'meadow-copper-signal-anchor-3071';
const TITLE = 'Harbor Bank';

function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

async function device(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto('/');
  return page;
}

/** A holds a vault with one item, and shows its pairing text; returns it. */
async function invite(a: Page): Promise<string> {
  await createVault(a, PASSWORD_A);
  await button(a, 'New item').click();
  await button(a, 'Login').click();
  await a.getByTestId('item-title').fill(TITLE);
  await button(a, 'Save').click();
  await expect(a.getByRole('heading', { name: TITLE })).toBeVisible();

  await button(a, 'Settings').click();
  await button(a, 'Pair a new device…').click();
  await a.getByTestId('pairing-same-network').check();
  await fillPassword(a.getByTestId('invite-password'), PASSWORD_A);
  await button(a, 'Start pairing').click();
  const text = a.getByTestId('pairing-text');
  await expect(text).not.toHaveValue('', { timeout: 30_000 });
  return text.inputValue();
}

/** B, with no vault, creates its password, takes A's text and shows its answer; returns it. */
async function join(b: Page, offer: string): Promise<string> {
  await startScreen(b);
  await button(b, 'Pair with an existing device').click();
  await fillPassword(b.getByTestId('new-password'), PASSWORD_B);
  await fillPassword(b.getByTestId('confirm-password'), PASSWORD_B);
  await b.getByTestId('pairing-same-network').check();
  await button(b, 'Continue').click();
  await b.getByTestId('pairing-paste').fill(offer, { timeout: 30_000 });
  await button(b, 'Continue').click();
  const text = b.getByTestId('pairing-text');
  await expect(text).not.toHaveValue('', { timeout: 30_000 });
  return text.inputValue();
}

/** Both devices reach the SAS; returns it, as shown on A. */
async function toSas(browser: Browser) {
  const a = await device(browser);
  const b = await device(browser);
  const offer = await invite(a);
  expect(offer).toMatch(/^[0-9A-Z $%*+\-./:]+$/);
  const answer = await join(b, offer);
  await a.getByTestId('pairing-paste').fill(answer);
  await button(a, 'Connect').click();
  const sasA = a.getByTestId('pairing-sas');
  const sasB = b.getByTestId('pairing-sas');
  await expect(sasA).toHaveText(/^\d{3} \d{3}$/, { timeout: 30_000 });
  await expect(sasB).toHaveText(/^\d{3} \d{3}$/, { timeout: 30_000 });
  const sas = await sasA.textContent();
  expect(await sasB.textContent()).toBe(sas);
  return { a, b };
}

test('pairs two devices: the same number on both, then B holds the vault (§8.4, Gate C)', async ({
  browser,
}) => {
  const { a, b } = await toSas(browser);
  await button(a, 'Yes, the same').click();
  await expect(a.getByText('Waiting for the other device…')).toBeVisible();
  await button(b, 'Yes, the same').click();

  // B: unlocked, "Vault ready" with a backup and no pairing, then A's item.
  await expect(b.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 60_000 });
  await expect(b.getByTestId('ready-backup')).toBeVisible();
  await expect(b.getByTestId('ready-pair')).toHaveCount(0);
  await openVault(b);
  await expect(b.getByRole('button', { name: new RegExp(TITLE) })).toBeVisible();

  // A: the paired device's name, then both devices, each synced with the other (D34).
  await expect(a.getByTestId('pairing-done')).toContainText('is paired', { timeout: 60_000 });
  await button(a, 'Done').click();
  const devicesA = a.getByTestId('device');
  await expect(devicesA).toHaveCount(2);
  await expect(a.getByTestId('device-last-sync')).toContainText('Last synced with this device: ');
  await expect(a.getByTestId('device-last-sync')).not.toContainText('never');
  await expect(a.getByTestId('device-pending')).toHaveCount(0);
  await button(b, 'Settings').click();
  await expect(b.getByTestId('device')).toHaveCount(2);
  await expect(b.getByTestId('device-last-sync')).not.toContainText('never');

  // B's vault opens with B's own password.
  await button(b, 'Lock').click();
  await fillPassword(b.getByTestId('unlock-password'), PASSWORD_B);
  await button(b, 'Unlock').click();
  await expect(b.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });
});

test('numbers said to differ stop the pairing on both, and B keeps nothing (§6.4, CRYPTO-INV-011)', async ({
  browser,
}) => {
  const { a, b } = await toSas(browser);
  await button(b, 'No, it differs').click();
  await expect(b.getByTestId('pairing-failed')).toHaveAttribute('data-reason', 'sas-mismatch');
  await expect(a.getByTestId('pairing-failed')).toHaveAttribute('data-reason', 'sas-mismatch');
  await expect(a.getByTestId('device')).toHaveCount(1);
  expect(await b.evaluate(async () => (await indexedDB.databases()).length)).toBe(0);
  // Again: a new session, from B's password step.
  await button(b, 'Start again').click();
  await expect(b.getByTestId('new-password')).toBeVisible();
});

test('a lock on A while the numbers are shown stops the pairing on B (D93)', async ({
  browser,
}) => {
  const { a, b } = await toSas(browser);
  await button(b, 'Yes, the same').click();
  await button(a, 'Lock').click();
  await expect(b.getByTestId('pairing-failed')).toHaveAttribute('data-reason', 'locked');
  expect(await b.evaluate(async () => (await indexedDB.databases()).length)).toBe(0);
});

test('B hidden for 60 seconds while joining stops the pairing, as a lock would (D93, D203)', async ({
  browser,
}) => {
  const { a, b } = await toSas(browser);
  // Fake time from now on: the hidden-app timer starts after it.
  await b.clock.install();
  await b.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await b.clock.runFor(59_000);
  await expect(b.getByTestId('pairing-sas')).toBeVisible();
  await b.clock.runFor(1_000);
  await expect(a.getByTestId('pairing-failed')).toHaveAttribute('data-reason', 'locked');
  // B is back at its password step, with nothing kept.
  await expect(b.getByTestId('new-password')).toBeVisible();
  expect(await b.evaluate(async () => (await indexedDB.databases()).length)).toBe(0);
});
