import { RecordType } from '@blindvault/crypto';
import { type Browser, type Page, expect, test } from '@playwright/test';

import { corruptRecords } from './corrupt';
import {
  answerConfirmation,
  checkSameNetwork,
  createVault,
  openSettingsPage,
  startScreen,
  switchSettingsPage,
} from './create';
import { PAIRING_URL } from '../playwright.config';
import { fillPassword } from './password';

// The manual sync flow between two paired installations, each in its own browser context, through
// the screens alone (§9.1, sync-protocol.md §3 to §5, D216): the user picks the other device on
// both, one shows its code first, the codes are copied and pasted, the same network only (no STUN
// server), and both connect, then prove their registered identities with Noise_KK (D217); closing
// on one ends the other with `abort` (D218); between them, each gets the records the other lacks
// (D222), and concurrent edits converge in that one sync, the loser in the history of both (D223),
// cut to the same 20 versions, the device whose edit the cut dropped telling its user (D6, D70);
// an older edit never brings a trashed item back (CRYPTO-INV-013), and an item trashed on one is in
// the trash of both with the same purge date and no way to purge it by hand (D7, D94); a Recovery
// Phrase regenerated on one reaches the other, which tells its user, and of two regenerations the
// device whose phrase lost is warned and offered a backup (D43, D145, D185); once both committed,
// the session stays live outside Settings and an edit reaches the peer at once, until End or a lock
// (D225); Settings shows the sync on its peer's row and the last sync, with its time, on both (D226). A
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
  await openSettingsPage(a, 'devices');
  await button(a, 'Pair a device…').click();
  await checkSameNetwork(a);
  await fillPassword(a.getByTestId('invite-password'), PASSWORD_A);
  await button(a, 'Start pairing').click();
  const offer = a.getByTestId('pairing-text');
  await expect(offer).not.toHaveValue('', { timeout: 30_000 });

  await startScreen(b);
  await button(b, 'Pair with an existing device').click();
  await fillPassword(b.getByTestId('new-password'), PASSWORD_B);
  await fillPassword(b.getByTestId('confirm-password'), PASSWORD_B);
  await checkSameNetwork(b);
  await button(b, 'Start pairing').click();
  await b.getByTestId('pairing-paste').fill(await offer.inputValue(), { timeout: 30_000 });
  await button(b, 'Show my answer').click();
  const answer = b.getByTestId('pairing-text');
  await expect(answer).not.toHaveValue('', { timeout: 30_000 });
  await a.getByTestId('pairing-paste').fill(await answer.inputValue());
  await button(a, 'Connect').click();
  await expect(a.getByTestId('pairing-sas')).toBeVisible({ timeout: 30_000 });
  await button(a, 'Yes, the same').click();
  await button(b, 'Yes, the same').click();
  await expect(b.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 60_000 });
  await expect(a.getByTestId('pairing-done')).toBeVisible({ timeout: 60_000 });
  await button(a, 'Close').click();
  await openSettingsPage(b, 'devices');
  return { a, b };
}

test('two paired devices connect from their sync codes, each with the other picked (D216)', async ({
  browser,
}) => {
  const { a, b } = await paired(browser);
  // B locks at once when hidden; A keeps the default delay (D93, D105).
  await switchSettingsPage(b, 'locking');
  await b.getByTestId('hiddenLockSeconds').fill('0');
  await button(b, 'Save').click();
  await expect(b.getByText('Saved.')).toBeVisible();
  await switchSettingsPage(b, 'devices');

  // Each picks the other device; A shows its code first, B reads it.
  await a.getByTestId('device-sync').click();
  const syncA = a.getByTestId('sync');
  await checkSameNetwork(syncA);
  await syncA.getByTestId('sync-first').click();
  const offer = syncA.getByTestId('pairing-text');
  await expect(offer).not.toHaveValue('', { timeout: 30_000 });
  const offerText = await offer.inputValue();
  expect(offerText).toMatch(/^[0-9A-Z $%*+\-./:]+$/);
  await expect(syncA).toContainText('encrypted for');
  await expect(
    syncA.getByText(
      'Leaving BlindVault to copy or paste counts as hiding it: if it stays hidden for 60 seconds, the sync ends.',
    ),
  ).toBeVisible();

  await b.getByTestId('device-sync').click();
  const syncB = b.getByTestId('sync');
  await checkSameNetwork(syncB);
  await syncB.getByTestId('sync-read').click();
  await expect(
    syncB.getByText(
      'This vault locks as soon as BlindVault is hidden, which ends the sync: copy and paste without leaving the app, or change the hidden-app lock in Settings › Locking.',
    ),
  ).toBeVisible();
  await syncB.getByTestId('pairing-paste').fill(offerText);
  await button(b, 'Show my answer').click();
  const answer = syncB.getByTestId('pairing-text');
  await expect(answer).not.toHaveValue('', { timeout: 30_000 });
  await expect(syncB).toContainText('encrypted for');
  await expect(syncB).not.toContainText('network addresses');

  // A's own code handed back to it is refused, and A keeps waiting (§4.3, D215).
  await syncA.getByTestId('pairing-paste').fill(offerText);
  await button(a, 'Connect').click();
  await expect(syncA).toContainText('This code is not from');
  await syncA.getByTestId('pairing-paste').fill(await answer.inputValue());
  await button(a, 'Connect').click();

  await expect(a.getByTestId('sync-done')).toBeVisible({ timeout: 30_000 });
  await expect(b.getByTestId('sync-done')).toBeVisible({ timeout: 30_000 });
  await expect(a.getByTestId('merge-result')).toContainText('Merged: 0 added, 0 replaced.');

  // Ending on A ends B's sync with A's abort, inside the Noise channel (§11.2, D218).
  await a.getByTestId('sync-end').click();
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

  // Retiring asks first, saying it cannot be undone and is not revocation (D41, D45).
  await a.getByTestId('device-retire').click();
  const confirm = a.getByRole('button', { name: /^Retire / });
  const nameB = ((await confirm.textContent()) ?? '').replace(/^Retire /, '');
  await expect(
    a.getByText(
      `Retire ${nameB}? Retirement cannot be undone. It is not revocation: whatever that device already holds stays readable to whoever has it. If it may be in someone else’s hands, re-found the vault.`,
    ),
  ).toBeVisible();
  // B completed its pairing: no advice to look at it first (D34).
  await expect(a.getByText(/^Before retiring /)).toHaveCount(0);
  await confirm.click();
  await expect(a.getByTestId('device')).toHaveCount(1);
  const retired = a.getByTestId('retired-devices');
  await retired.locator('summary').click();
  await expect(retired).toContainText(
    'A retired device learns it is retired only when told: sync with it from here, and it receives only its Device record, marked retired.',
  );
  await retired.getByTestId('device-notify').click();
  const syncA = a.getByTestId('sync');
  await expect(syncA).toContainText(`Tell ${nameB} it is retired`);
  await expect(syncA).toContainText(
    `On ${nameB}, open Settings → Devices and choose “Sync” next to this device. This device sends ${nameB} only its Device record, marked retired, and the sync ends: ${nameB} then shows that it was retired and stops syncing.`,
  );
  await checkSameNetwork(syncA);
  await syncA.getByTestId('sync-first').click();
  const offer = syncA.getByTestId('pairing-text');
  await expect(offer).not.toHaveValue('', { timeout: 30_000 });

  // B does not know yet: it picks A as for any sync.
  await b.getByTestId('device-sync').click();
  const syncB = b.getByTestId('sync');
  await checkSameNetwork(syncB);
  await syncB.getByTestId('sync-read').click();
  await syncB.getByTestId('pairing-paste').fill(await offer.inputValue());
  await button(b, 'Show my answer').click();
  const answer = syncB.getByTestId('pairing-text');
  await expect(answer).not.toHaveValue('', { timeout: 30_000 });
  await syncA.getByTestId('pairing-paste').fill(await answer.inputValue());
  await button(a, 'Connect').click();

  await expect(a.getByTestId('sync-failed')).toHaveAttribute('data-reason', 'retired-peer', {
    timeout: 30_000,
  });
  await expect(a.getByTestId('sync-failed')).toHaveText(
    `${nameB} is retired: this device told it so and sent it nothing else, and the sync ended.`,
  );
  await expect(b.getByTestId('sync-failed')).toHaveAttribute('data-reason', 'retired', {
    timeout: 30_000,
  });
  await expect(b.getByTestId('sync-failed')).toHaveText(
    /^This device was retired on another device, and .+ passed that on, so the sync ended\. This device can no longer sync\.$/,
  );
  await expect(b.getByTestId('own-retired')).toBeVisible();
  // B, now retired, offers no sync, no pairing and no re-admission, and says why (D41, D45).
  await button(b, 'Start again').click();
  await expect(b.getByTestId('device-sync')).toHaveCount(0);
  await expect(b.getByTestId('invite')).toContainText(
    'This device was retired: it cannot pair another device.',
  );
  await expect(button(b, 'Pair a device…')).toHaveCount(0);
  await expect(b.getByTestId('readmit-device')).toContainText(
    'This device was retired: it cannot be re-admitted. Replace it by pairing to sync.',
  );
  await switchSettingsPage(b, 'refound');
  // Re-founding on B says it cannot sync first, in place of the advice to sync (D47).
  await b.getByTestId('refound-start').click();
  const warnings = b.getByTestId('refound-warnings');
  await expect(warnings).toContainText(
    'This device was retired, so it cannot sync first: changes that exist only on other devices are lost. If a device that was not retired is still in your hands, re-found there instead.',
  );
  await expect(warnings).not.toContainText('Sync this device first');
});

test('A retires B during an open sync: B merges its retired record and shows the D41 notice (D69, D220)', async ({
  browser,
}) => {
  const { a, b } = await paired(browser);

  await a.getByTestId('device-sync').click();
  const syncA = a.getByTestId('sync');
  await checkSameNetwork(syncA);
  await syncA.getByTestId('sync-first').click();
  const offer = syncA.getByTestId('pairing-text');
  await expect(offer).not.toHaveValue('', { timeout: 30_000 });
  await b.getByTestId('device-sync').click();
  const syncB = b.getByTestId('sync');
  await checkSameNetwork(syncB);
  await syncB.getByTestId('sync-read').click();
  await syncB.getByTestId('pairing-paste').fill(await offer.inputValue());
  await button(b, 'Show my answer').click();
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

/** Connects A and B from Settings › Devices, A showing its code first. */
async function connect(a: Page, b: Page) {
  await a.getByTestId('device-sync').click();
  const syncA = a.getByTestId('sync');
  await checkSameNetwork(syncA);
  await syncA.getByTestId('sync-first').click();
  const offer = syncA.getByTestId('pairing-text');
  await expect(offer).not.toHaveValue('', { timeout: 30_000 });
  await b.getByTestId('device-sync').click();
  const syncB = b.getByTestId('sync');
  await checkSameNetwork(syncB);
  await syncB.getByTestId('sync-read').click();
  await syncB.getByTestId('pairing-paste').fill(await offer.inputValue());
  await button(b, 'Show my answer').click();
  const answer = syncB.getByTestId('pairing-text');
  await expect(answer).not.toHaveValue('', { timeout: 30_000 });
  await syncA.getByTestId('pairing-paste').fill(await answer.inputValue());
  await button(a, 'Connect').click();
}

/** Syncs A and B as `connect` does; both end on the merge result. */
async function synced(a: Page, b: Page) {
  await connect(a, b);
  await expect(b.getByTestId('sync-done')).toBeVisible({ timeout: 30_000 });
  await expect(a.getByTestId('sync-done')).toBeVisible({ timeout: 30_000 });
}

/** B ends the sync, which ends A's with `ended` (D218); both go back to the vault. */
async function closed(a: Page, b: Page) {
  await b.getByTestId('sync-end').click();
  await expect(a.getByTestId('sync-failed')).toHaveAttribute('data-reason', 'ended');
  await a.getByTestId('sync-again').click();
  for (const page of [a, b]) {
    await button(page, 'Back').click();
    await button(page, 'Back').click();
  }
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
  await button(a, 'Back').click();
  await newLogin(a, 'ACME');
  await openSettingsPage(a, 'devices');

  await synced(a, b);
  await expect(b.getByTestId('merge-result')).toContainText('Merged: 1 added, 0 replaced.');
  await b.getByTestId('sync-end').click();
  await button(b, 'Back').click();
  await button(b, 'Back').click();
  // B still shows "Vault ready" from its pairing (D198).
  await button(b, 'Open the vault').click();
  await expect(button(b, 'ACME')).toBeVisible();
});

test('a record of A that fails verification stops the sync before it is sent: A names it, B is told, nothing merges (§8, D181, CRYPTO-INV-018)', async ({
  browser,
}) => {
  const { a, b } = await paired(browser);
  await button(a, 'Back').click();
  await button(a, 'Back').click();
  await newLogin(a, 'ACME');
  await openSettingsPage(a, 'devices');
  // B lacks the item, so A reads it again from storage and verifies it before sending (D181).
  expect(await corruptRecords(a, RecordType.item)).toBeGreaterThan(0);

  await connect(a, b);
  const failedA = a.getByTestId('sync-failed');
  await expect(failedA).toHaveAttribute('data-reason', 'send-failed', { timeout: 30_000 });
  await expect(failedA).toHaveText(
    /^A record on this device, \S+ [0-9a-f]+, failed verification, so the sync stopped before sending it\. Nothing was merged\.$/,
  );
  const failedB = b.getByTestId('sync-failed');
  await expect(failedB).toHaveAttribute('data-reason', 'peer-verification-failed', {
    timeout: 30_000,
  });
  await expect(failedB).toContainText('failed verification, so the sync stopped');
  await expect(failedB).toContainText('Nothing was merged.');

  await b.getByTestId('sync-again').click();
  await button(b, 'Back').click();
  await button(b, 'Back').click();
  await button(b, 'Open the vault').click();
  await expect(button(b, 'ACME')).toHaveCount(0);
});

test('the stored record of a retired B that fails verification: A sends nothing, B is not retired (§6, D181, CRYPTO-INV-018)', async ({
  browser,
}) => {
  const { a, b } = await paired(browser);
  await a.getByTestId('device-retire').click();
  await a.getByRole('button', { name: /^Retire / }).click();
  await expect(a.getByTestId('device')).toHaveCount(1);
  // A sends a retired device only its record, read again from storage and verified (§6, D181).
  expect(await corruptRecords(a, RecordType.device)).toBeGreaterThan(0);
  const retired = a.getByTestId('retired-devices');
  await retired.locator('summary').click();
  await retired.getByTestId('device-notify').click();
  const syncA = a.getByTestId('sync');
  await checkSameNetwork(syncA);
  await syncA.getByTestId('sync-first').click();
  const offer = syncA.getByTestId('pairing-text');
  await expect(offer).not.toHaveValue('', { timeout: 30_000 });
  await b.getByTestId('device-sync').click();
  const syncB = b.getByTestId('sync');
  await checkSameNetwork(syncB);
  await syncB.getByTestId('sync-read').click();
  await syncB.getByTestId('pairing-paste').fill(await offer.inputValue());
  await button(b, 'Show my answer').click();
  const answer = syncB.getByTestId('pairing-text');
  await expect(answer).not.toHaveValue('', { timeout: 30_000 });
  await syncA.getByTestId('pairing-paste').fill(await answer.inputValue());
  await button(a, 'Connect').click();

  const failedA = a.getByTestId('sync-failed');
  await expect(failedA).toHaveAttribute('data-reason', 'verification-failed', { timeout: 30_000 });
  await expect(failedA).toHaveText(
    /^The record of .+ on this device failed verification, so nothing was sent and the sync stopped\.$/,
  );
  await expect(b.getByTestId('sync-failed')).toHaveAttribute(
    'data-reason',
    'peer-verification-failed',
    { timeout: 30_000 },
  );
  await expect(b.getByTestId('own-retired')).toHaveCount(0);
  await b.getByTestId('sync-again').click();
  await expect(b.getByTestId('device-sync')).toHaveCount(1);
});

test('concurrent edits converge in one sync: the newer wins on both, the other in the history of both (D6, D223)', async ({
  browser,
}) => {
  const { a, b } = await paired(browser);
  await button(a, 'Back').click();
  await button(a, 'Back').click();
  await newLogin(a, 'ACME');
  await openSettingsPage(a, 'devices');
  await synced(a, b);
  await closed(a, b);
  await button(b, 'Open the vault').click();

  // A edits first, then B, so B's is the newer write.
  await rename(a, 'ACME', 'ACME on A');
  await rename(b, 'ACME', 'ACME on B');
  for (const page of [a, b]) await openSettingsPage(page, 'devices');
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

test('the history cut drops an edit of A in one sync: only A tells its user, and both keep 20 (D6, D70)', async ({
  browser,
}) => {
  const { a, b } = await paired(browser);
  await button(a, 'Back').click();
  await button(a, 'Back').click();
  await newLogin(a, 'ACME');
  await openSettingsPage(a, 'devices');
  await synced(a, b);
  await closed(a, b);
  await button(b, 'Open the vault').click();

  // A's edit is older than B's 21, whose versions fill the history of 20.
  await rename(a, 'ACME', 'ACME on A');
  let title = 'ACME';
  for (let i = 0; i <= 20; i++) {
    await rename(b, title, `B ${String(i)}`);
    title = `B ${String(i)}`;
  }
  for (const page of [a, b]) await openSettingsPage(page, 'devices');
  await synced(a, b);
  const notice = 'An older edit made on this device no longer fits the history of: ACME on A.';
  await expect(a.getByText(notice)).toBeVisible();
  await expect(b.getByText(notice)).toHaveCount(0);

  await closed(a, b);
  for (const page of [a, b]) {
    await button(page, title).click();
    await button(page, 'History').click();
    const versions = page.locator('article').getByRole('listitem');
    await expect(versions).toHaveCount(20);
    await expect(versions.filter({ hasText: 'ACME on A' })).toHaveCount(0);
  }
});

test('an edit older than a trash never brings the item back: in the trash on both, the edit kept in its history (CRYPTO-INV-013)', async ({
  browser,
}) => {
  const { a, b } = await paired(browser);
  await button(a, 'Back').click();
  await button(a, 'Back').click();
  await newLogin(a, 'ACME');
  await openSettingsPage(a, 'devices');
  await synced(a, b);
  await closed(a, b);
  await button(b, 'Open the vault').click();

  // A edits first, then B trashes, so the trash is the newer write.
  await rename(a, 'ACME', 'ACME on A');
  await button(b, 'ACME').click();
  await button(b, 'More actions').click();
  await button(b, 'Move to trash').click();
  for (const page of [a, b]) await openSettingsPage(page, 'devices');
  await synced(a, b);

  await closed(a, b);
  for (const page of [a, b]) {
    await expect(page.getByRole('heading', { name: 'First steps' })).toBeVisible();
    await button(page, 'Trash').click();
    await button(page, 'ACME').click();
    // An item in the trash offers only restore (D143): restored, its history shows A's edit.
    await button(page, 'Restore from the trash').click();
    await expect(page.getByText('The trash is empty.')).toBeVisible();
    await button(page, 'All items').click();
    await button(page, 'ACME').click();
    await button(page, 'History').click();
    const versions = page.locator('article').getByRole('listitem');
    await expect(versions.filter({ hasText: 'ACME on A' })).toHaveCount(1);
  }
});

test('an item trashed on A is in the trash of both with the same purge date, offering only restore (D7, D94, D143)', async ({
  browser,
}) => {
  const { a, b } = await paired(browser);
  await button(a, 'Back').click();
  await button(a, 'Back').click();
  await newLogin(a, 'ACME');
  await openSettingsPage(a, 'devices');
  await synced(a, b);
  await closed(a, b);
  await button(b, 'Open the vault').click();

  await button(a, 'ACME').click();
  await button(a, 'More actions').click();
  await button(a, 'Move to trash').click();
  await openSettingsPage(a, 'devices');
  await openSettingsPage(b, 'devices');
  await synced(a, b);

  await closed(a, b);
  const dates: string[] = [];
  for (const page of [a, b]) {
    await expect(page.getByRole('heading', { name: 'First steps' })).toBeVisible();
    await button(page, 'Trash').click();
    await button(page, 'ACME').click();
    const notice = page.getByText(/It can only be restored from the trash; it is purged on /);
    await expect(notice).toBeVisible();
    dates.push((await notice.textContent()) ?? '');
    // Purge is automatic only: nothing deletes it by hand (D94).
    await expect(button(page, 'Restore from the trash')).toBeVisible();
    await expect(page.getByRole('button', { name: /delete|purge|empty/i })).toHaveCount(0);
  }
  expect(dates[1]).toBe(dates[0]);
});

/** The 8 hex digits naming the current phrase in Settings (D185). */
async function currentId(page: Page): Promise<string> {
  const text = (await page.getByTestId('recovery-current').textContent()) ?? '';
  return /\(([0-9a-f]{8})\)/.exec(text)?.[1] ?? '';
}

/** Regenerates the Recovery Phrase from Settings; returns the new phrase's name. */
async function regenerate(page: Page, password: string): Promise<string> {
  await page.getByTestId('regenerate-start').click();
  await button(page, 'Show the new phrase').click();
  await expect(page.getByTestId('recovery-phrase')).toBeVisible();
  const words: string[] = [];
  for (let n = 1; n <= 24; n++) {
    words.push((await page.getByTestId(`phrase-word-${String(n)}`).textContent()) ?? '');
  }
  await button(page, 'I wrote them down').click();
  await answerConfirmation(page, words);
  await page.getByTestId('regenerate-password').fill(password);
  await button(page, 'Regenerate').click();
  await expect(page.getByTestId('regenerate-done')).toBeVisible({ timeout: 30_000 });
  return currentId(page);
}

test('a phrase regenerated on A reaches B in one sync, which tells its user and that no backup made there opens with it (D43, D185)', async ({
  browser,
}) => {
  const { a, b } = await paired(browser);
  await switchSettingsPage(b, 'backup');
  await b.getByTestId('backup-password').fill(PASSWORD_B);
  await Promise.all([b.waitForEvent('download', { timeout: 60_000 }), button(b, 'Export').click()]);
  await switchSettingsPage(b, 'recovery');
  await expect(b.getByTestId('recovery-no-backup')).toHaveCount(0);
  await switchSettingsPage(a, 'recovery');
  const id = await regenerate(a, PASSWORD_A);

  await switchSettingsPage(a, 'devices');
  await switchSettingsPage(b, 'devices');
  await synced(a, b);
  await expect(b.getByTestId('merge-result')).toContainText(
    `The Recovery Phrase was regenerated on another device: the new one, ${id},`,
  );
  await expect(a.getByTestId('merge-result')).not.toContainText('Recovery Phrase');
  await switchSettingsPage(b, 'recovery');
  expect(await currentId(b)).toBe(id);
  // B's backup was made for the previous phrase.
  await expect(b.getByTestId('recovery-no-backup')).toBeVisible();
});

test('of two regenerations, the later is kept on both and A, whose phrase lost, is warned and offered a backup (D145, D185)', async ({
  browser,
}) => {
  const { a, b } = await paired(browser);
  await switchSettingsPage(a, 'recovery');
  await switchSettingsPage(b, 'recovery');
  const lost = await regenerate(a, PASSWORD_A);
  const kept = await regenerate(b, PASSWORD_B);
  expect(kept).not.toBe(lost);

  await switchSettingsPage(a, 'devices');
  await switchSettingsPage(b, 'devices');
  await synced(a, b);
  await expect(b.getByTestId('merge-result')).not.toContainText('Recovery Phrase');
  const warning = a.getByTestId('phrase-superseded');
  await expect(warning).toContainText(
    `The Recovery Phrase you wrote down for this device, ${lost},`,
  );
  await expect(warning).toContainText('keep it until you have a new backup');
  await warning.getByRole('button', { name: 'Make a backup now', exact: true }).click();
  await expect(a.getByTestId('backup-password')).toBeFocused();
  for (const page of [a, b]) {
    await switchSettingsPage(page, 'recovery');
    expect(await currentId(page)).toBe(kept);
  }
});

test('a live sync outlives Settings: an item made in the vault reaches the peer at once, until End (D225)', async ({
  browser,
}) => {
  const { a, b } = await paired(browser);
  await synced(a, b);
  for (const page of [a, b]) {
    await expect(page.getByTestId('live-sync')).toContainText('Live sync with', {
      timeout: 30_000,
    });
  }
  // Closing its panel keeps it open, as leaving Settings does (D234).
  await a.getByTestId('sync-close').click();
  await expect(a.getByTestId('sync')).toHaveCount(0);
  await expect(a.getByTestId('live-sync')).toBeVisible();
  await button(a, 'Back').click();
  await button(a, 'Back').click();
  await button(b, 'Back').click();
  await button(b, 'Back').click();
  await button(b, 'Open the vault').click();
  await expect(a.getByTestId('live-sync')).toBeVisible();
  await newLogin(a, 'Made while live');
  await expect(button(b, 'Made while live')).toBeVisible({ timeout: 30_000 });
  await expect(b.getByTestId('live-sync')).toBeVisible();

  // Show opens the sync, with every merge added up.
  await b.getByTestId('live-sync-show').click();
  await expect(b.getByTestId('merge-result')).toContainText('Merged: 1 added');
  await a.getByTestId('live-sync-end').click();
  await expect(a.getByTestId('live-sync')).toHaveCount(0);
  await expect(b.getByTestId('sync-failed')).toHaveAttribute('data-reason', 'ended', {
    timeout: 30_000,
  });
  await expect(b.getByTestId('live-sync')).toHaveCount(0);
});

test('a lock ends the live sync on both (D93, D225)', async ({ browser }) => {
  const { a, b } = await paired(browser);
  await synced(a, b);
  await expect(a.getByTestId('live-sync')).toBeVisible({ timeout: 30_000 });
  await button(a, 'Back').click();
  await button(a, 'Back').click();
  await expect(a.getByTestId('live-sync')).toBeVisible();
  await button(b, 'Lock').click();
  await expect(a.getByTestId('live-sync')).toHaveCount(0, { timeout: 30_000 });
});

test('Settings shows the sync on the row of its peer while it runs, and the last sync with its time on both (D34, D226)', async ({
  browser,
}) => {
  const { a, b } = await paired(browser);
  // The pairing is the first completed sync (D34).
  for (const page of [a, b]) {
    await expect(page.getByTestId('device-sync-state')).toHaveCount(0);
    await switchSettingsPage(page, 'storage');
    await expect(page.getByTestId('device-last-sync-any')).toHaveText(/^Last sync: .+, with .+\.$/);
    await switchSettingsPage(page, 'devices');
  }
  const before = await a.getByTestId('device-last-sync').innerText();
  await synced(a, b);
  for (const page of [a, b]) {
    await expect(page.getByTestId('device-sync-state')).toHaveAttribute('data-state', 'live', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('device-sync-state')).toHaveText('Live sync');
    await expect(page.getByTestId('device-last-sync')).toHaveText(
      /^Last synced with this device: .+\d{1,2}:\d{2}/,
    );
    await switchSettingsPage(page, 'storage');
    await expect(page.getByTestId('device-last-sync-any')).toHaveText(
      /^Last sync: .+\d{1,2}:\d{2}.*, with .+\.$/,
    );
    await switchSettingsPage(page, 'devices');
  }
  expect(before).toMatch(/\d{1,2}:\d{2}/);
  await a.getByTestId('sync-end').click();
  for (const page of [a, b]) {
    await expect(page.getByTestId('device-sync-state')).toHaveCount(0, { timeout: 30_000 });
  }
});
