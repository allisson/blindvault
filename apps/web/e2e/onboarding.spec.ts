import { type Page, expect, test } from '@playwright/test';

import { confirmPhrase, openVault, startScreen } from './create';

// The first screen, the three starts and "Vault ready" (overview §13.3, D198).

// Calibrating Argon2id targets about 1 s per derivation (D9), on every browser.
test.setTimeout(90_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';
const SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15';
/** Playwright's WebKit names itself Safari, and is: the other tests take another browser's name. */
const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

test.use({ userAgent: CHROME });

function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

/** Creates the vault and stops on "Vault ready". */
async function create(page: Page) {
  await page.goto('/');
  await confirmPhrase(page);
  await page.getByTestId('new-password').fill(PASSWORD);
  await page.getByTestId('confirm-password').fill(PASSWORD);
  await button(page, 'Create vault').click();
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });
  await expect(page.getByTestId('ready')).toBeVisible();
}

test('says that no server can reset the vault, then offers the three starts (§13.3, D198)', async ({
  page,
}) => {
  await page.goto('/');
  await startScreen(page);
  await expect(page.getByTestId('no-server').getByRole('listitem')).toHaveText([
    'BlindVault has no account and no server: your vault lives only on your devices and in your backups.',
    'Nobody, BlindVault included, can reset your local password or recover your vault for you.',
    'Your Recovery Phrase and a backup are the only way to get the vault back.',
  ]);
  for (const start of [
    'Create a new vault',
    'Pair with an existing device',
    'Restore from a backup',
  ]) {
    await expect(button(page, start)).toBeVisible();
  }
  // Not Safari: no advice to install first, and no storage warning.
  await expect(page.getByRole('heading', { name: 'Install BlindVault first' })).toHaveCount(0);
  await expect(page.getByTestId('storage-warning')).toHaveCount(0);

  // The pair start joins a pairing: this device's local password first (§13.3, D203).
  await button(page, 'Pair with an existing device').click();
  await expect(page.getByRole('heading', { name: 'Pair with an existing device' })).toBeVisible();
  await expect(page.getByText(/First create this device’s local password/)).toBeVisible();
  await expect(page.getByTestId('new-password')).toBeVisible();
  await expect(page.getByTestId('pairing-same-network')).not.toBeChecked();
  await button(page, 'Back').click();
  await expect(button(page, 'Pair with an existing device')).toBeVisible();
  await button(page, 'Restore from a backup').click();
  await expect(page.getByRole('heading', { name: 'Restore from a backup' })).toBeVisible();
  await expect(page.getByTestId('restore-file')).toBeAttached();
  await button(page, 'Cancel').click();
  await expect(button(page, 'Create a new vault')).toBeVisible();
});

for (const width of [390, 1280] as const) {
  test(`shows "Vault ready" once after a creation, at ${String(width)} px (§13.3, D198)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await create(page);
    const ready = page.getByTestId('ready');
    await expect(ready.getByRole('heading', { name: 'Vault ready' })).toBeVisible();
    // In place of the panes, and of the backup reminder it lists.
    await expect(page.getByTestId('panes')).toBeHidden();
    await expect(page.getByTestId('backup-reminder')).toHaveCount(0);
    // A backup, then pairing (D203); nothing that belongs to a restore.
    await expect(ready.getByTestId('ready-backup')).toContainText('keep it off this device');
    await expect(ready.getByRole('listitem').last()).toHaveAttribute('data-testid', 'ready-pair');
    await expect(ready.getByTestId('ready-pair')).toContainText('second copy');
    await expect(ready.getByTestId('ready-pair').getByRole('button')).toHaveText('Pair a device');
    await expect(ready.getByTestId('ready-check-phrase')).toHaveCount(0);
    await expect(ready.getByTestId('ready-readmit')).toHaveCount(0);

    // N would open a new item unseen under it: ignored.
    await page.keyboard.press('n');
    await expect(ready).toBeVisible();
    await expect(button(page, 'Save')).toHaveCount(0);

    // Its action opens Settings with the cursor in the export; back returns to it.
    await button(page, 'Make a backup').click();
    await expect(page.getByTestId('backup-password')).toBeFocused();
    await expect(ready).toHaveCount(0);
    await button(page, 'Back').click();
    await expect(ready).toBeVisible();

    // Closed: the vault, with the backup reminder, and never again after an unlock.
    await openVault(page);
    await expect(page.getByTestId('panes')).toBeVisible();
    await expect(page.getByTestId('backup-reminder')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await button(page, 'Lock').click();
    await page.getByTestId('unlock-password').fill(PASSWORD);
    await button(page, 'Unlock').click();
    await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });
    await expect(page.getByTestId('panes')).toBeVisible();
    await expect(ready).toHaveCount(0);
  });
}

test('a lock on "Vault ready" clears it (D198)', async ({ page }) => {
  await create(page);
  await button(page, 'Lock').click();
  await expect(page.getByTestId('lock-state')).toHaveText('Locked');
  await page.getByTestId('unlock-password').fill(PASSWORD);
  await button(page, 'Unlock').click();
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });
  await expect(page.getByTestId('ready')).toHaveCount(0);
  await expect(page.getByTestId('panes')).toBeVisible();
});

test('recommends passkey unlock first where the browser has it (§13.3, D198)', async ({
  page,
  browserName,
}) => {
  // Only Chromium has a virtual authenticator Playwright can drive (CDP WebAuthn domain).
  test.skip(browserName !== 'chromium', 'virtual authenticator is Chromium-only');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    },
  });
  await create(page);
  const ready = page.getByTestId('ready');
  await expect(ready.getByRole('listitem').first()).toHaveAttribute('data-testid', 'ready-passkey');
  // Its action opens Settings with the cursor in the passkey setup, which asks for the password.
  await button(page, 'Set up a passkey').click();
  await expect(page.getByTestId('passkey-password')).toBeFocused();
});

test.describe('Safari', () => {
  test.use({ userAgent: SAFARI });

  test('advises installing the app before the three starts, again after a reload (D103, D198)', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Install BlindVault first' })).toBeVisible();
    await expect(page.getByText(/does not share this tab’s storage/).first()).toBeVisible();
    await expect(page.getByText(/Add to Home Screen on iPhone and iPad/).first()).toBeVisible();
    await expect(button(page, 'Create a new vault')).toHaveCount(0);
    await expect(button(page, 'Restore from a backup')).toHaveCount(0);
    // No vault yet: the warning says to start in the installed app, with nothing to move.
    const warning = page.getByTestId('storage-warning');
    await expect(warning).toHaveAttribute('data-warning', 'safari-tab');
    await expect(warning).toContainText('start there');
    await expect(warning).not.toContainText('move the vault');

    await button(page, 'Continue in this tab').click();
    await expect(button(page, 'Create a new vault')).toBeVisible();
    await expect(button(page, 'Pair with an existing device')).toBeVisible();
    await expect(warning).toContainText('start there');

    // The choice is not stored.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Install BlindVault first' })).toBeVisible();
  });
});
