import { type Page, expect, test } from '@playwright/test';

import { MEMLIMIT } from '@blindvault/crypto';
import { type ItemInput } from '@blindvault/vault';

import { buildVault, install } from './load-fixture';

// A stored passkey in the app (extension.md §7.5, §7.6, D288): the viewer shows its site, user name
// and creation date, never its private key or userHandle and no copy of them; search reads the site
// and the user name only; the editor removes it after the history notice, and history keeps it.

test.setTimeout(3 * 60_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';
const RP_ID = 'mail.lantern.example';
// An Ed25519 key in the RFC 8410 layout, and a userHandle, with bytes recognizable in the page.
const PRIVATE_KEY = Uint8Array.from([
  ...[
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
  ],
  ...new Uint8Array(32).fill(0xc7),
]);
const USER_HANDLE = new Uint8Array(16).fill(0xab);
// 2026-09-21 12:00 UTC.
const CREATED_AT = Date.UTC(2026, 8, 21, 12);

const ITEM: ItemInput = {
  templateId: 'login',
  templateVersion: 1,
  title: 'Lantern Mail',
  fields: [
    { type: 'text', role: 'username', value: 'rui.costa' },
    {
      type: 'passkey',
      value: {
        privateKey: PRIVATE_KEY,
        credentialId: new Uint8Array(16).fill(0x5e),
        rpId: RP_ID,
        userHandle: USER_HANDLE,
        userName: 'rui.costa@lantern.example',
        createdAt: CREATED_AT,
      },
    },
  ],
  tags: [],
};

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const base64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const base64url = (b: Uint8Array) => Buffer.from(b).toString('base64url');

function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

/** Neither the private key nor the userHandle is anywhere in the page, in any common encoding. */
async function expectNoKey(page: Page) {
  const html = (await page.content()).toLowerCase();
  for (const bytes of [PRIVATE_KEY, USER_HANDLE]) {
    for (const text of [hex(bytes), base64(bytes), base64url(bytes)]) {
      expect(html).not.toContain(text.toLowerCase());
    }
  }
  expect(html).not.toContain('c7c7c7c7');
  expect(html).not.toContain('abababab');
}

test('shows a passkey without its key, finds it by site, and removes it with the notice (D288)', async ({
  page,
}) => {
  const fixture = await buildVault(PASSWORD, { opslimit: 3, memlimit: MEMLIMIT }, 0, 0, [ITEM]);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await install(page, fixture);
  await page.reload();
  await page.getByTestId('unlock-password').fill(PASSWORD);
  await button(page, 'Unlock').click();
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 2 * 60_000 });

  // Search reads the site and the user name, never the key or the userHandle.
  const search = page.getByTestId('search');
  const results = page.getByRole('region', { name: 'Results' });
  await search.fill('lantern.example');
  await expect(results.getByTestId('row-title')).toHaveText(['Lantern Mail']);
  await search.fill('rui.costa@lantern');
  await expect(results.getByTestId('row-title')).toHaveText(['Lantern Mail']);
  for (const query of [hex(USER_HANDLE), base64(USER_HANDLE), hex(PRIVATE_KEY).slice(-16)]) {
    await search.fill(query);
    await expect(page.getByText('No items match.')).toBeVisible();
  }
  await search.fill('');

  await button(page, 'Lantern Mail').click();
  const passkey = page.getByTestId('passkey');
  await expect(passkey).toContainText(RP_ID);
  await expect(passkey).toContainText('rui.costa@lantern.example');
  await expect(passkey).toContainText('Created on September 21, 2026');
  await expect(page.getByRole('term').filter({ hasText: 'Passkey' })).toBeVisible();
  // No copy for the passkey; the user name field keeps its own.
  await expect(page.getByRole('button', { name: /^Copy: Passkey/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Copy: / })).toHaveCount(1);
  await expectNoKey(page);

  // The editor removes it only after the notice; cancelling keeps it.
  await button(page, 'Edit').click();
  const field = page.getByTestId('passkey-field');
  await expect(field).toContainText(RP_ID);
  await expectNoKey(page);
  await field.getByRole('button', { name: 'Remove', exact: true }).click();
  const dialog = page.getByTestId('passkey-remove-confirm');
  await expect(dialog).toContainText(
    `The passkey for ${RP_ID} leaves this item when you save, but it stays in the item’s history`,
  );
  await expect(dialog).toContainText(`Remove the passkey on ${RP_ID} too`);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(field).toBeVisible();
  await field.getByRole('button', { name: 'Remove', exact: true }).click();
  await dialog.getByRole('button', { name: 'Remove the passkey', exact: true }).click();
  await expect(field).toHaveCount(0);
  await button(page, 'Save').click();
  await expect(page.getByRole('heading', { name: 'Lantern Mail', level: 1 })).toBeVisible();
  await expect(page.getByTestId('passkey')).toHaveCount(0);

  // History keeps the version that held it, shown the same way.
  await button(page, 'History').first().click();
  await expect(page.getByTestId('passkey').first()).toContainText(RP_ID);
  await expectNoKey(page);
});
