import { type Page, expect, test } from '@playwright/test';

import { createVault, openSettingsPage } from './create';
import { storedPlaintext } from './stored';

// Import (overview §15, D123, D125, D146): preview, one commit into a landing folder, the delete
// reminder; an encrypted export refused; a lock before the commit writes nothing; no plaintext of
// the file stored.

// Creation and the unlock each run Argon2id at about 1 s (D9).
test.setTimeout(120_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';
const FOLDER = /^Imported from Bitwarden /;
const USERNAME = 'lucas.prado.4417';
const SECRET = 'Ember-Quill-8830-Fjord';
const NOTE = 'Gate code 5512 behind the shed';

function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

function exportFile(encrypted: boolean) {
  const json = JSON.stringify({
    encrypted,
    folders: [{ id: 'f', name: 'Work' }],
    items: [
      {
        id: '1',
        type: 1,
        name: 'Google',
        folderId: 'f',
        login: { username: USERNAME, password: SECRET },
      },
      { id: '2', type: 2, name: 'Wifi', notes: NOTE, secureNote: { type: 0 } },
    ],
  });
  return { name: 'bitwarden_export.json', mimeType: 'application/json', buffer: Buffer.from(json) };
}

async function preview(page: Page) {
  await openSettingsPage(page, 'import');
  await page.getByTestId('import-start').click();
  await page.getByTestId('import-source').selectOption('bitwarden');
  await expect(page.getByText('holds every secret in plaintext')).toBeVisible();
  await page.getByTestId('import-file').setInputFiles(exportFile(true));
  await expect(
    page.getByText('This Bitwarden export is encrypted. Export it again unencrypted'),
  ).toBeVisible();
  await page.getByTestId('import-file').setInputFiles(exportFile(false));
  const shown = page.getByTestId('import-preview');
  await expect(shown).toContainText('2 items to import into a new folder, Imported from Bitwarden');
  await expect(shown).toContainText('0 entries skipped');
  await expect(shown).toContainText('0 attachments dropped');
  // No file password: the wizard counts three steps (D253).
  await expect(page.getByTestId('wizard-step')).toHaveText('Step 2 of 3 · Check what comes in');
}

test('imports a Bitwarden export into a landing folder in one commit, after a preview (D125)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await createVault(page, PASSWORD);

  // A lock before the commit writes nothing (§7).
  await preview(page);
  await button(page, 'Lock').click();
  await page.getByTestId('unlock-password').fill(PASSWORD);
  await button(page, 'Unlock').click();
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });
  await expect(page.getByRole('button', { name: FOLDER })).toHaveCount(0);

  await preview(page);
  await page.getByTestId('import-confirm').click();
  await expect(page.getByTestId('import-result').getByRole('status')).toContainText(
    'Imported 2 items into Imported from Bitwarden',
  );
  await expect(page.getByTestId('import-result')).toContainText('Delete bitwarden_export.json now');

  await button(page, 'Back').click();
  await button(page, 'Back').click();
  await page.getByRole('button', { name: FOLDER }).click();
  await expect(button(page, 'Wifi')).toBeVisible();
  await page.getByRole('list', { name: 'Folders' }).getByRole('button', { name: 'Work' }).click();
  await expect(button(page, 'Google')).toBeVisible();

  // Nothing read from the file reaches IndexedDB or localStorage (§18, CRYPTO-INV-001).
  const stored = await storedPlaintext(page, [
    'Google',
    'Wifi',
    USERNAME,
    SECRET,
    NOTE,
    'Imported from',
  ]);
  expect(stored.chunks).toBeGreaterThan(0);
  expect(stored.found).toEqual([]);
});
