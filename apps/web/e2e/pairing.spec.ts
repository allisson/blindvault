import { RecordType } from '@blindvault/crypto';
import { type Browser, type Page, expect, test } from '@playwright/test';

import { corruptRecords } from './corrupt';
import {
  createVault,
  openSettingsPage,
  openVault,
  startScreen,
  switchSettingsPage,
} from './create';
import { PAIRING_URL } from '../playwright.config';
import { fillPassword } from './password';

// A pairing between two installations, each in its own browser context, through the screens alone
// (§8.4, D202, D203): the texts copied and pasted, the same network only (no STUN server), the SAS
// compared and confirmed on both, then B holds the vault.

// Creation, A's password again and B's password each run Argon2id at about 1 s (D9).
test.setTimeout(240_000);

test.beforeEach(({ browserName }) => {
  // Copy/paste with no camera: both sides send only mDNS names, which WebKit does not connect on
  // the Linux runner (architecture.md). The QR spec keeps the skip: its camera is a canvas, not a
  // capture (D208).
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
const CHANNEL =
  'Whoever sees this code, or whatever carries this text, a message or an email, sees this device’s network addresses. Nothing else: the numbers compared next protect the pairing.';

function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

async function device(browser: Browser, clock = false): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  // The app reads the clock it found at load: a fake one goes in before (it runs at real speed).
  if (clock) await page.clock.install();
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

  await openSettingsPage(a, 'devices');
  await button(a, 'Pair a device…').click();
  await a.getByTestId('pairing-same-network').check();
  await fillPassword(a.getByTestId('invite-password'), PASSWORD_A);
  await button(a, 'Start pairing').click();
  const text = a.getByTestId('pairing-text');
  await expect(text).not.toHaveValue('', { timeout: 30_000 });
  // What the code or the text carries shows this device's network addresses (D208).
  await expect(a.getByText(CHANNEL)).toBeVisible();
  return text.inputValue();
}

/** B, with no vault, creates its password, takes A's text and shows its answer; returns it. */
async function join(b: Page, offer: string): Promise<string> {
  await startScreen(b);
  await button(b, 'Pair with an existing device').click();
  await fillPassword(b.getByTestId('new-password'), PASSWORD_B);
  await fillPassword(b.getByTestId('confirm-password'), PASSWORD_B);
  await b.getByTestId('pairing-same-network').check();
  await button(b, 'Start pairing').click();
  await b.getByTestId('pairing-paste').fill(offer, { timeout: 30_000 });
  await button(b, 'Show my answer').click();
  const text = b.getByTestId('pairing-text');
  await expect(text).not.toHaveValue('', { timeout: 30_000 });
  await expect(b.getByText(CHANNEL)).toBeVisible();
  return text.inputValue();
}

/** Both devices reach the SAS; returns it, as shown on A. */
async function toSas(browser: Browser, clockA = false) {
  const a = await device(browser, clockA);
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
  await button(a, 'Close').click();
  const devicesA = a.getByTestId('device');
  await expect(devicesA).toHaveCount(2);
  await expect(a.getByTestId('device-last-sync')).toContainText('Last synced with this device: ');
  await expect(a.getByTestId('device-last-sync')).not.toContainText('never');
  await expect(a.getByTestId('device-pending')).toHaveCount(0);
  await openSettingsPage(b, 'devices');
  await expect(b.getByTestId('device')).toHaveCount(2);
  await expect(b.getByTestId('device-last-sync')).not.toContainText('never');

  // B's vault opens with B's own password.
  await button(b, 'Lock').click();
  await fillPassword(b.getByTestId('unlock-password'), PASSWORD_B);
  await button(b, 'Unlock').click();
  await expect(b.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });

  // Erasing B names its Device record, to retire from A, before and after (D205).
  await openSettingsPage(b, 'devices');
  const own = b.getByTestId('device').filter({ hasText: '(this device)' });
  const nameB = ((await own.locator('span.font-medium').textContent()) ?? '')
    .replace(' (this device)', '')
    .trim();
  expect(nameB).not.toBe('');
  await switchSettingsPage(b, 'erase');
  const named = `Afterwards, retire this device's Device record, "${nameB}", from another device: until then they keep offering it as a sync peer.`;
  await button(b, 'Erase this vault from this device…').click();
  await expect(b.getByTestId('erase-warning').getByText(named, { exact: true })).toBeVisible();
  await b.getByTestId('erase-understood').check();
  await button(b, 'Erase').click();
  await startScreen(b);
  await expect(b.getByTestId('erased').getByText(named, { exact: true })).toBeVisible();
});

test('a clock gone back far on a paired device offers replacing its vault by pairing again (D149, D153)', async ({
  browser,
}) => {
  const { a, b } = await toSas(browser, true);
  await button(a, 'Yes, the same').click();
  await button(b, 'Yes, the same').click();
  await expect(a.getByTestId('pairing-done')).toContainText('is paired', { timeout: 60_000 });
  await button(a, 'Close').click();

  // A writes 400 days ahead, then its clock goes back: B is another device to pair again from.
  const now = await a.evaluate(() => Date.now());
  await a.clock.setSystemTime(now + 400 * 24 * 60 * 60 * 1000);
  await button(a, 'Back').click();
  await button(a, 'Back').click();
  await button(a, 'New item').click();
  await button(a, 'Login').click();
  await a.getByTestId('item-title').fill('Ahead');
  await button(a, 'Save').click();
  await expect(a.getByRole('heading', { name: 'Ahead' })).toBeVisible();
  await a.clock.setSystemTime(now);
  await button(a, 'Lock').click();
  await fillPassword(a.getByTestId('unlock-password'), PASSWORD_A);
  await button(a, 'Unlock').click();
  await expect(a.getByTestId('clock-behind')).toContainText(
    'Or replace this device’s vault by pairing with another device: lock, then choose “Replace by pairing with another device…”.',
    { timeout: 30_000 },
  );
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

test('a record of A that fails verification stops the pairing on both, and B keeps nothing (D181, CRYPTO-INV-018)', async ({
  browser,
}) => {
  const { a, b } = await toSas(browser);
  // After the SAS, A reads every record again from storage and verifies it before sending (D181).
  expect(await corruptRecords(a, RecordType.item)).toBeGreaterThan(0);
  await button(a, 'Yes, the same').click();
  await button(b, 'Yes, the same').click();
  for (const page of [a, b]) {
    const failed = page.getByTestId('pairing-failed');
    await expect(failed).toHaveAttribute('data-reason', 'verification-failed', { timeout: 60_000 });
    await expect(failed).toContainText(
      'A record failed verification, so the pairing stopped and the other device kept nothing.',
    );
  }
  // A admitted B before the transfer, so it lists B as a pairing not completed (D34).
  await expect(a.getByTestId('device')).toHaveCount(2);
  await expect(a.getByTestId('device-pending')).toHaveText(
    'Pairing not completed: this device never got the confirmation that the other one kept the vault.',
  );
  // Retiring it first advises looking at it: only the confirmation may have been lost (D34).
  await a.getByTestId('device-retire').click();
  const confirm = a.getByRole('button', { name: /^Retire / });
  const nameB = ((await confirm.textContent()) ?? '').replace(/^Retire /, '');
  await expect(
    a.getByText(
      `Before retiring ${nameB}, look at it: if it shows the vault, the pairing succeeded, and only its confirmation was lost.`,
      { exact: true },
    ),
  ).toBeVisible();
  await button(a, 'Cancel').click();
  await expect(a.getByTestId('device')).toHaveCount(2);
  expect(await b.evaluate(async () => (await indexedDB.databases()).length)).toBe(0);
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

test('a hidden-app lock at 0 says it locks at once, in Settings, the export and the pairing, and another says its delay (D93, D105)', async ({
  browser,
}) => {
  const a = await device(browser);
  await createVault(a, PASSWORD_A);
  await openSettingsPage(a, 'locking');
  const immediate =
    'At 0 the vault locks as soon as the app is hidden, including during a file picker or passkey prompt on some systems.';
  const exportHidden =
    'The vault locks as soon as the app is hidden: if the browser hides it while it saves the file, the vault locks, and the export must be repeated.';
  await expect(a.getByText(immediate)).toHaveCount(0);
  await switchSettingsPage(a, 'backup');
  await expect(a.getByText(exportHidden)).toHaveCount(0);
  await switchSettingsPage(a, 'locking');
  await a.getByTestId('hiddenLockSeconds').fill('0');
  await expect(a.getByText(immediate)).toBeVisible();
  await button(a, 'Save').click();
  await expect(a.getByText('Saved.')).toBeVisible();
  await switchSettingsPage(a, 'backup');
  await expect(a.getByText(exportHidden)).toBeVisible();

  await switchSettingsPage(a, 'devices');
  await button(a, 'Pair a device…').click();
  await a.getByTestId('pairing-same-network').check();
  await fillPassword(a.getByTestId('invite-password'), PASSWORD_A);
  await button(a, 'Start pairing').click();
  await expect(a.getByTestId('pairing-text')).not.toHaveValue('', { timeout: 30_000 });
  await expect(
    a.getByText(
      'This vault locks as soon as BlindVault is hidden, which ends the pairing: copy and paste without leaving the app, or change the hidden-app lock in Settings › Locking.',
    ),
  ).toBeVisible();
  await a.getByTestId('pairing-cancel').click();

  await switchSettingsPage(a, 'locking');
  await a.getByTestId('hiddenLockSeconds').fill('30');
  await expect(a.getByText(immediate)).toHaveCount(0);
  await button(a, 'Save').click();
  await expect(a.getByText('Saved.')).toBeVisible();
  await switchSettingsPage(a, 'backup');
  await expect(a.getByText(exportHidden)).toHaveCount(0);
  await switchSettingsPage(a, 'devices');
  await button(a, 'Pair a device…').click();
  await a.getByTestId('pairing-same-network').check();
  await fillPassword(a.getByTestId('invite-password'), PASSWORD_A);
  await button(a, 'Start pairing').click();
  await expect(a.getByTestId('pairing-text')).not.toHaveValue('', { timeout: 30_000 });
  await expect(
    a.getByText(
      'Leaving BlindVault to copy or paste counts as hiding it: if it stays hidden for 30 seconds, the pairing ends.',
    ),
  ).toBeVisible();
});

const PASSWORD_NEW = 'harbor-violet-ember-sextant-5820';

/** B holds a vault of its own with one item, locked, and starts replacing it by pairing (D204). */
async function replacing(browser: Browser) {
  const a = await device(browser);
  const b = await device(browser);
  await createVault(b, PASSWORD_B);
  await button(b, 'New item').click();
  await button(b, 'Login').click();
  await b.getByTestId('item-title').fill('Old item');
  await button(b, 'Save').click();
  await expect(b.getByRole('heading', { name: 'Old item' })).toBeVisible();
  await button(b, 'Lock').click();
  await button(b, 'Replace by pairing with another device…').click();
  await expect(b.getByTestId('replace-warning')).toContainText(
    'Changes that exist only on this device are lost',
  );
  await fillPassword(b.getByTestId('new-password'), PASSWORD_NEW);
  await fillPassword(b.getByTestId('confirm-password'), PASSWORD_NEW);
  await b.getByTestId('pairing-same-network').check();
  // Nothing starts before the user confirms the replacement (D183, D204).
  await expect(button(b, 'Start pairing')).toBeDisabled();
  await b.getByTestId('replace-understood').check();

  const offer = await invite(a);
  await button(b, 'Start pairing').click();
  await b.getByTestId('pairing-paste').fill(offer, { timeout: 30_000 });
  await button(b, 'Show my answer').click();
  const text = b.getByTestId('pairing-text');
  await expect(text).not.toHaveValue('', { timeout: 30_000 });
  await a.getByTestId('pairing-paste').fill(await text.inputValue());
  await button(a, 'Connect').click();
  await expect(a.getByTestId('pairing-sas')).toHaveText(/^\d{3} \d{3}$/, { timeout: 30_000 });
  await expect(b.getByTestId('pairing-sas')).toHaveText(
    (await a.getByTestId('pairing-sas').textContent()) ?? '',
    { timeout: 30_000 },
  );
  return { a, b };
}

test('replaces a locked vault by pairing: B then holds only the other vault (D150, D204)', async ({
  browser,
}) => {
  const { a, b } = await replacing(browser);
  await button(a, 'Yes, the same').click();
  await button(b, 'Yes, the same').click();
  await expect(b.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 60_000 });
  await openVault(b);
  await expect(b.getByRole('button', { name: new RegExp(TITLE) })).toBeVisible();
  await expect(b.getByRole('button', { name: /Old item/ })).toHaveCount(0);
  // The old database is deleted once the new one commits (D89).
  await expect.poll(() => b.evaluate(async () => (await indexedDB.databases()).length)).toBe(1);
  await button(b, 'Lock').click();
  await fillPassword(b.getByTestId('unlock-password'), PASSWORD_NEW);
  await button(b, 'Unlock').click();
  await expect(b.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });
});

test('numbers said to differ leave the vault being replaced intact (D150, D153)', async ({
  browser,
}) => {
  const { a, b } = await replacing(browser);
  await button(b, 'No, it differs').click();
  await expect(a.getByTestId('pairing-failed')).toHaveAttribute('data-reason', 'sas-mismatch');
  await button(b, 'Start again').click();
  await button(b, 'Back').click();
  await fillPassword(b.getByTestId('unlock-password'), PASSWORD_B);
  await button(b, 'Unlock').click();
  await expect(b.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });
  await expect(b.getByRole('button', { name: /Old item/ })).toBeVisible();
});
