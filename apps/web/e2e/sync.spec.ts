import { type Browser, type Page, expect, test } from '@playwright/test';

import { createVault, startScreen } from './create';
import { PAIRING_URL } from '../playwright.config';
import { fillPassword } from './password';

// The manual sync flow between two paired installations, each in its own browser context, through
// the screens alone (§9.1, sync-protocol.md §3 to §5, D216): the user picks the other device on
// both, one shows its code first, the codes are copied and pasted, the same network only (no STUN
// server), and both connect, then prove their registered identities with Noise_KK (D217); closing
// on one ends the other with `abort` (D218); between them, each gets the records the other lacks
// (D222), and concurrent edits converge in that one sync, the loser in the history of both (D223). A
// device that retired the other tells it so through the same screens, sending it only its
// retired record (D219), and a device retired during an open sync is told so at once (D69, D220).

// Creation, A's password again and B's password each run Argon2id at about 1 s (D9).
test.setTimeout(240_000);

test.beforeEach(({ browserName }) => {
  // Copy/paste with no camera: both sides send only mDNS names, which WebKit does not connect on
  // the Linux runner (architecture.md, D203).
  test.skip(
    browserName === 'webkit' && process.platform === 'linux',
    'WebKit on Linux does not connect over mDNS names only',
  );
});

// Firefox gathers no ICE candidate on `localhost`: this spec runs on 127.0.0.1 (playwright.config.ts).
test.use({ baseURL: PAIRING_URL });

const PASSWORD_A = 'quartz-lantern-velvet-harbor-9214';
const PASSWORD_B = 'meadow-copper-signal-anchor-3071';

function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

async function device(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto('/');
  return page;
}

/** A creates a vault and pairs B by copy/paste; both end in Settings › Devices. */
async function paired(browser: Browser) {
  const a = await device(browser);
  const b = await device(browser);
  await createVault(a, PASSWORD_A);
  await button(a, 'Settings').click();
  await button(a, 'Pair a new device…').click();
  await a.getByTestId('pairing-same-network').check();
  await fillPassword(a.getByTestId('invite-password'), PASSWORD_A);
  await button(a, 'Start pairing').click();
  const offer = a.getByTestId('pairing-text');
  await expect(offer).not.toHaveValue('', { timeout: 30_000 });

  await startScreen(b);
  await button(b, 'Pair with an existing device').click();
  await fillPassword(b.getByTestId('new-password'), PASSWORD_B);
  await fillPassword(b.getByTestId('confirm-password'), PASSWORD_B);
  await b.getByTestId('pairing-same-network').check();
  await button(b, 'Continue').click();
  await b.getByTestId('pairing-paste').fill(await offer.inputValue(), { timeout: 30_000 });
  await button(b, 'Continue').click();
  const answer = b.getByTestId('pairing-text');
  await expect(answer).not.toHaveValue('', { timeout: 30_000 });
  await a.getByTestId('pairing-paste').fill(await answer.inputValue());
  await button(a, 'Connect').click();
  await expect(a.getByTestId('pairing-sas')).toBeVisible({ timeout: 30_000 });
  await button(a, 'Yes, the same').click();
  await button(b, 'Yes, the same').click();
  await expect(b.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 60_000 });
  await expect(a.getByTestId('pairing-done')).toBeVisible({ timeout: 60_000 });
  await button(a, 'Done').click();
  await button(b, 'Settings').click();
  return { a, b };
}

test('two paired devices connect from their sync codes, each with the other picked (D216)', async ({
  browser,
}) => {
  const { a, b } = await paired(browser);

  // Each picks the other device; A shows its code first, B reads it.
  await a.getByTestId('device-sync').click();
  const syncA = a.getByTestId('sync');
  await syncA.getByTestId('pairing-same-network').check();
  await syncA.getByTestId('sync-first').click();
  const offer = syncA.getByTestId('pairing-text');
  await expect(offer).not.toHaveValue('', { timeout: 30_000 });
  const offerText = await offer.inputValue();
  expect(offerText).toMatch(/^[0-9A-Z $%*+\-./:]+$/);
  await expect(syncA).toContainText('encrypted for');

  await b.getByTestId('device-sync').click();
  const syncB = b.getByTestId('sync');
  await syncB.getByTestId('pairing-same-network').check();
  await syncB.getByTestId('sync-read').click();
  await syncB.getByTestId('pairing-paste').fill(offerText);
  await button(b, 'Next').click();
  const answer = syncB.getByTestId('pairing-text');
  await expect(answer).not.toHaveValue('', { timeout: 30_000 });

  // A's own code handed back to it is refused, and A keeps waiting (§4.3, D215).
  await syncA.getByTestId('pairing-paste').fill(offerText);
  await button(a, 'Connect').click();
  await expect(syncA).toContainText('This code is not from');
  await syncA.getByTestId('pairing-paste').fill(await answer.inputValue());
  await button(a, 'Connect').click();

  await expect(a.getByTestId('sync-done')).toBeVisible({ timeout: 30_000 });
  await expect(b.getByTestId('sync-done')).toBeVisible({ timeout: 30_000 });
  await expect(a.getByTestId('merge-result')).toContainText('Merged: 0 added, 0 replaced.');

  // Closing on A ends B's sync with A's abort, inside the Noise channel (§11.2, D218).
  await a.getByTestId('sync-close').click();
  await expect(a.getByTestId('sync')).toHaveCount(0);
  await expect(b.getByTestId('sync-failed')).toHaveAttribute('data-reason', 'ended', {
    timeout: 30_000,
  });
  await expect(b.getByTestId('sync-failed')).toContainText('ended the sync');
});

test('A retires B, then tells it: B merges its retired record and shows the D41 notice (D219)', async ({
  browser,
}) => {
  const { a, b } = await paired(browser);

  await a.getByTestId('device-retire').click();
  await a.getByRole('button', { name: /^Retire / }).click();
  await expect(a.getByTestId('device')).toHaveCount(1);
  const retired = a.getByTestId('retired-devices');
  await retired.locator('summary').click();
  await retired.getByTestId('device-notify').click();
  const syncA = a.getByTestId('sync');
  await expect(syncA).toContainText('it is retired');
  await syncA.getByTestId('pairing-same-network').check();
  await syncA.getByTestId('sync-first').click();
  const offer = syncA.getByTestId('pairing-text');
  await expect(offer).not.toHaveValue('', { timeout: 30_000 });

  // B does not know yet: it picks A as for any sync.
  await b.getByTestId('device-sync').click();
  const syncB = b.getByTestId('sync');
  await syncB.getByTestId('pairing-same-network').check();
  await syncB.getByTestId('sync-read').click();
  await syncB.getByTestId('pairing-paste').fill(await offer.inputValue());
  await button(b, 'Next').click();
  const answer = syncB.getByTestId('pairing-text');
  await expect(answer).not.toHaveValue('', { timeout: 30_000 });
  await syncA.getByTestId('pairing-paste').fill(await answer.inputValue());
  await button(a, 'Connect').click();

  await expect(a.getByTestId('sync-failed')).toHaveAttribute('data-reason', 'retired-peer', {
    timeout: 30_000,
  });
  await expect(b.getByTestId('sync-failed')).toHaveAttribute('data-reason', 'retired', {
    timeout: 30_000,
  });
  await expect(b.getByTestId('own-retired')).toBeVisible();
  // B, now retired, offers no sync (D41, D45).
  await button(b, 'Start again').click();
  await expect(b.getByTestId('device-sync')).toHaveCount(0);
});

test('A retires B during an open sync: B merges its retired record and shows the D41 notice (D69, D220)', async ({
  browser,
}) => {
  const { a, b } = await paired(browser);

  await a.getByTestId('device-sync').click();
  const syncA = a.getByTestId('sync');
  await syncA.getByTestId('pairing-same-network').check();
  await syncA.getByTestId('sync-first').click();
  const offer = syncA.getByTestId('pairing-text');
  await expect(offer).not.toHaveValue('', { timeout: 30_000 });
  await b.getByTestId('device-sync').click();
  const syncB = b.getByTestId('sync');
  await syncB.getByTestId('pairing-same-network').check();
  await syncB.getByTestId('sync-read').click();
  await syncB.getByTestId('pairing-paste').fill(await offer.inputValue());
  await button(b, 'Next').click();
  const answer = syncB.getByTestId('pairing-text');
  await expect(answer).not.toHaveValue('', { timeout: 30_000 });
  await syncA.getByTestId('pairing-paste').fill(await answer.inputValue());
  await button(a, 'Connect').click();
  await expect(a.getByTestId('sync-done')).toBeVisible({ timeout: 30_000 });
  await expect(b.getByTestId('sync-done')).toBeVisible({ timeout: 30_000 });

  // The sync stays on screen while A retires B from the list above it.
  await a.getByTestId('device-retire').click();
  await a.getByRole('button', { name: /^Retire / }).click();
  await expect(a.getByTestId('sync-failed')).toHaveAttribute('data-reason', 'retired-peer', {
    timeout: 30_000,
  });
  await expect(b.getByTestId('sync-failed')).toHaveAttribute('data-reason', 'retired', {
    timeout: 30_000,
  });
  await expect(b.getByTestId('own-retired')).toBeVisible();
});

/** Syncs A and B from Settings › Devices, A showing its code first; both end on the merge result. */
async function synced(a: Page, b: Page) {
  await a.getByTestId('device-sync').click();
  const syncA = a.getByTestId('sync');
  await syncA.getByTestId('pairing-same-network').check();
  await syncA.getByTestId('sync-first').click();
  const offer = syncA.getByTestId('pairing-text');
  await expect(offer).not.toHaveValue('', { timeout: 30_000 });
  await b.getByTestId('device-sync').click();
  const syncB = b.getByTestId('sync');
  await syncB.getByTestId('pairing-same-network').check();
  await syncB.getByTestId('sync-read').click();
  await syncB.getByTestId('pairing-paste').fill(await offer.inputValue());
  await button(b, 'Next').click();
  const answer = syncB.getByTestId('pairing-text');
  await expect(answer).not.toHaveValue('', { timeout: 30_000 });
  await syncA.getByTestId('pairing-paste').fill(await answer.inputValue());
  await button(a, 'Connect').click();
  await expect(b.getByTestId('sync-done')).toBeVisible({ timeout: 30_000 });
  await expect(a.getByTestId('sync-done')).toBeVisible({ timeout: 30_000 });
}

/** B closes the sync, which ends A's with `ended` (D218); both go back to the vault. */
async function closed(a: Page, b: Page) {
  await b.getByTestId('sync-close').click();
  await expect(a.getByTestId('sync-failed')).toHaveAttribute('data-reason', 'ended');
  await a.getByTestId('sync-again').click();
  for (const page of [a, b]) await button(page, 'Back').click();
}

async function newLogin(page: Page, title: string) {
  await button(page, 'New item').click();
  await button(page, 'Login').click();
  await page.getByTestId('item-title').fill(title);
  await button(page, 'Save').click();
}

async function rename(page: Page, from: string, to: string) {
  await button(page, from).click();
  await button(page, 'Edit').click();
  await page.getByTestId('item-title').fill(to);
  await button(page, 'Save').click();
}

test('an item created on A reaches B through a sync, and B shows the merge (D222)', async ({
  browser,
}) => {
  const { a, b } = await paired(browser);
  await button(a, 'Back').click();
  await newLogin(a, 'ACME');
  await button(a, 'Settings').click();

  await synced(a, b);
  await expect(b.getByTestId('merge-result')).toContainText('Merged: 1 added, 0 replaced.');
  await b.getByTestId('sync-close').click();
  await button(b, 'Back').click();
  // B still shows "Vault ready" from its pairing (D198).
  await button(b, 'Open the vault').click();
  await expect(button(b, 'ACME')).toBeVisible();
});

test('concurrent edits converge in one sync: the newer wins on both, the other in the history of both (D6, D223)', async ({
  browser,
}) => {
  const { a, b } = await paired(browser);
  await button(a, 'Back').click();
  await newLogin(a, 'ACME');
  await button(a, 'Settings').click();
  await synced(a, b);
  await closed(a, b);
  await button(b, 'Open the vault').click();

  // A edits first, then B, so B's is the newer write.
  await rename(a, 'ACME', 'ACME on A');
  await rename(b, 'ACME', 'ACME on B');
  for (const page of [a, b]) await button(page, 'Settings').click();
  await synced(a, b);
  await expect(a.getByTestId('merge-result')).toContainText('Merged: 0 added, 1 replaced.');
  await expect(b.getByTestId('merge-result')).toContainText('Merged: 0 added, 0 replaced.');

  await closed(a, b);
  for (const page of [a, b]) {
    await expect(button(page, 'ACME on A')).toHaveCount(0);
    await button(page, 'ACME on B').click();
    await button(page, 'History').click();
    // A's edit lost on both, and both keep it, above the first state.
    const versions = page.locator('article').getByRole('listitem');
    await expect(versions).toHaveCount(2);
    await expect(versions.first()).toContainText('ACME on A');
    await expect(versions.last()).toContainText('ACME');
  }
});
