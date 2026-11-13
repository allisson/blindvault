import { readFile } from 'node:fs/promises';

import { type CDPSession, type Page, expect, test } from '@playwright/test';

import { createVault, openSettingsPage } from './create';

// Calibrating Argon2id targets about 1 s per derivation (D9), on every browser.
test.setTimeout(120_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';

// Only Chromium has a virtual authenticator Playwright can drive (CDP WebAuthn domain).
test.skip(
  ({ browserName }) => browserName !== 'chromium',
  'virtual authenticator is Chromium-only',
);

async function authenticator(page: Page, synced: boolean) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
      defaultBackupEligibility: synced,
      defaultBackupState: synced,
    },
  });
  return { cdp, authenticatorId };
}

async function credentials(cdp: CDPSession, authenticatorId: string) {
  return (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials;
}

async function create(page: Page) {
  await page.goto('/');
  await createVault(page, PASSWORD);
}

async function setUp(page: Page, password = PASSWORD) {
  await openSettingsPage(page, 'passkey');
  await expect(page.getByText(/needs only its screen lock, fingerprint or face/)).toBeVisible();
  await page.getByTestId('passkey-password').fill(password);
  await page.getByRole('button', { name: 'Set up passkey', exact: true }).click();
}

async function lock(page: Page) {
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await expect(page.getByTestId('lock-state')).toHaveText('Locked');
}

test('sets up a device-bound passkey and unlocks with it (§5.5, D75)', async ({ page }) => {
  const { cdp, authenticatorId } = await authenticator(page, false);
  await create(page);
  await setUp(page);
  await expect(page.getByText('Passkey set up.')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('passkey-synced')).toHaveCount(0);
  await expect(page.getByText('Passkey unlock is set up on this device.')).toBeVisible();
  expect(await credentials(cdp, authenticatorId)).toHaveLength(1);

  await lock(page);
  await page.getByRole('button', { name: 'Unlock with passkey', exact: true }).click();
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });

  // Still offered after a reload, and the password keeps working.
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Unlock with passkey', exact: true }),
  ).toBeVisible();
  await page.getByTestId('unlock-password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });

  // Removed: no longer offered.
  await openSettingsPage(page, 'passkey');
  await page.getByRole('button', { name: 'Remove passkey', exact: true }).click();
  await expect(
    page.getByText('Passkey removed. Your passkey manager was asked to delete it.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect.poll(() => credentials(cdp, authenticatorId)).toHaveLength(0);
  await lock(page);
  await expect(page.getByRole('button', { name: 'Unlock with passkey', exact: true })).toHaveCount(
    0,
  );
});

test('states that a synced passkey depends on its platform account (D84)', async ({ page }) => {
  await authenticator(page, true);
  await create(page);
  await setUp(page);
  await expect(page.getByText('Passkey set up.')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('passkey-synced')).toContainText(
    'the vault now also depends on the security of that account',
  );
});

test('refuses setup with a wrong local password (D172)', async ({ page }) => {
  const { cdp, authenticatorId } = await authenticator(page, false);
  await create(page);
  await setUp(page, 'not the password at all');
  await expect(page.getByText('The current password is wrong.')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Passkey unlock is set up on this device.')).toHaveCount(0);
  // The credential that wraps nothing is signalled as unknown, and Chromium removes it (D120).
  await expect.poll(() => credentials(cdp, authenticatorId)).toHaveLength(0);
  await lock(page);
  await expect(page.getByRole('button', { name: 'Unlock with passkey', exact: true })).toHaveCount(
    0,
  );
});

test('gets no assertion when the authenticator cannot verify the user (D75)', async ({ page }) => {
  const { cdp, authenticatorId } = await authenticator(page, false);
  await create(page);
  await setUp(page);
  await expect(page.getByText('Passkey set up.')).toBeVisible({ timeout: 30_000 });
  await lock(page);
  // The app asks for user verification; a compliant browser then refuses the ceremony itself.
  await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
  await page.getByRole('button', { name: 'Unlock with passkey', exact: true }).click();
  await expect(
    page.getByText('The passkey prompt was closed. Try again, or use the password.'),
  ).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId('lock-state')).toHaveText('Locked');
});

test('rejects an assertion without user verification (D75, CRYPTO-INV-021)', async ({ page }) => {
  await authenticator(page, false);
  await create(page);
  await setUp(page);
  await expect(page.getByText('Passkey set up.')).toBeVisible({ timeout: 30_000 });
  await lock(page);
  // Chromium's virtual authenticator always verifies when it can and refuses when it cannot, so a
  // client that does not honor `userVerification: "required"` is simulated: the real assertion
  // comes back with the UV flag cleared in its authenticator data, PRF output included.
  await page.evaluate(() => {
    const get = navigator.credentials.get.bind(navigator.credentials);
    navigator.credentials.get = async (options) => {
      const credential = (await get(options)) as PublicKeyCredential;
      const response = credential.response as AuthenticatorAssertionResponse;
      const data = new Uint8Array(response.authenticatorData.slice(0));
      data[32] = (data[32] ?? 0) & ~0x04;
      Object.defineProperty(response, 'authenticatorData', { value: data.buffer });
      return credential;
    };
  });
  await page.getByRole('button', { name: 'Unlock with passkey', exact: true }).click();
  await expect(page.getByText(/did not verify you with a PIN, fingerprint or face/)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId('lock-state')).toHaveText('Locked');
  // The same passkey unlocks once its assertion reports user verification again.
  await page.reload();
  await page.getByRole('button', { name: 'Unlock with passkey', exact: true }).click();
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });
});

/** A browser without `signalUnknownCredential`: BlindVault cannot ask the manager to delete a passkey. */
async function noSignal(page: Page) {
  await page.addInitScript(() => {
    delete (PublicKeyCredential as { signalUnknownCredential?: unknown }).signalUnknownCredential;
  });
}

async function setUpAgain(page: Page) {
  await page.getByTestId('passkey-password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Set up passkey', exact: true }).click();
  await expect(page.getByText('Passkey set up.')).toBeVisible({ timeout: 30_000 });
}

test('with no way to ask the manager, removing, replacing or erasing says to delete the passkey by hand (D75, D153, D205)', async ({
  page,
}) => {
  await noSignal(page);
  await authenticator(page, false);
  await page.goto('/');
  const words = await createVault(page, PASSWORD);
  await setUp(page);
  await expect(page.getByText('Passkey set up.')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Remove passkey', exact: true }).click();
  await expect(
    page.getByText(
      'Passkey removed. It no longer unlocks anything: delete the "BlindVault" passkey in your passkey manager.',
      { exact: true },
    ),
  ).toBeVisible();

  // Replaced with its own backup while a passkey is set up.
  await setUpAgain(page);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByTestId('settings-backup').click();
  await page.getByTestId('backup-password').fill(PASSWORD);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.getByRole('button', { name: 'Export', exact: true }).click(),
  ]);
  const backup = await readFile(await download.path());
  await lock(page);
  await page.getByRole('button', { name: 'Replace with a backup…', exact: true }).click();
  await page.getByTestId('restore-file').setInputFiles({
    name: 'blindvault-backup.bvault',
    mimeType: 'application/octet-stream',
    buffer: backup,
  });
  await page.getByTestId('file-continue').click();
  await page.getByTestId('restore-phrase').fill(words.join(' '));
  await page.getByRole('button', { name: 'Open the backup', exact: true }).click();
  await page.getByTestId('new-password').fill(PASSWORD, { timeout: 30_000 });
  await page.getByTestId('confirm-password').fill(PASSWORD);
  await page.getByTestId('replace-understood').check();
  await page.getByRole('button', { name: 'Replace', exact: true }).click();
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 60_000 });
  await expect(
    page
      .getByTestId('leftover-passkey')
      .getByText(
        'The passkey of the replaced vault no longer unlocks anything: delete the "BlindVault" passkey you no longer use in your passkey manager.',
        { exact: true },
      ),
  ).toBeVisible();

  // Erased while a passkey is set up.
  await openSettingsPage(page, 'passkey');
  await setUpAgain(page);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByTestId('settings-erase').click();
  await page
    .getByRole('button', { name: 'Erase this vault from this device…', exact: true })
    .click();
  await page.getByTestId('erase-understood').check();
  await page.getByRole('button', { name: 'Erase', exact: true }).click();
  await expect(
    page
      .getByTestId('leftover-passkey')
      .getByText(
        'The passkey of the erased vault no longer unlocks anything: delete the "BlindVault" passkey you no longer use in your passkey manager.',
        { exact: true },
      ),
  ).toBeVisible({ timeout: 30_000 });
});
