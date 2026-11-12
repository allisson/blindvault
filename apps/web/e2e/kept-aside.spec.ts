import { RecordType } from '@blindvault/crypto';
import { type Page, expect, test } from '@playwright/test';

import { corruptRecords } from './corrupt';
import { createVault, openSettingsPage } from './create';

// Records that fail verification at unlock are kept aside (D181): the vault opens, and each screen
// that would hand them on or rely on them says why instead (D45, D202, D207), as does the
// Recovery Phrase check for a damaged Recovery Envelope (D180) and the re-founding, which leaves
// them behind (D72).

// Creation and the unlock each run Argon2id at about 1 s (D9).
test.setTimeout(180_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';

function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

test('records kept aside at unlock block pairing and re-admission, a damaged Recovery Envelope says so, and the re-founding counts them (D72, D180, D181)', async ({
  page,
}) => {
  await page.goto('/');
  await createVault(page, PASSWORD);
  await button(page, 'New item').click();
  await button(page, 'Login').click();
  await page.getByTestId('item-title').fill('Harbor Bank');
  await button(page, 'Save').click();
  await expect(page.getByRole('heading', { name: 'Harbor Bank' })).toBeVisible();

  const items = await corruptRecords(page, RecordType.item);
  const envelopes = await corruptRecords(page, RecordType.recoveryEnvelope);
  expect(items).toBeGreaterThan(0);
  expect(envelopes).toBe(1);
  await button(page, 'Lock').click();
  await page.getByTestId('unlock-password').fill(PASSWORD);
  await button(page, 'Unlock').click();
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });

  await openSettingsPage(page, 'devices');
  await expect(page.getByTestId('invite')).toContainText(
    'This device holds a record it cannot read: pairing would hand it on. Re-found the vault or restore a backup.',
  );
  await expect(button(page, 'Pair a device…')).toHaveCount(0);
  await expect(page.getByTestId('readmit-device')).toContainText(
    'This device holds a record it cannot read: re-admission would hand it on. Re-found the vault or restore a backup.',
  );
  await button(page, 'Back').click();
  await page.getByTestId('settings-recovery').click();
  await expect(
    page.getByText(
      'The Recovery Envelope on this device is damaged, so the Recovery Phrase cannot be checked. Regenerate the Recovery Phrase to replace it.',
    ),
  ).toBeVisible();

  await button(page, 'Back').click();
  await page.getByTestId('settings-refound').click();
  const refound = page.getByTestId('refound');
  await refound.getByTestId('refound-start').click();
  await expect(refound.getByTestId('refound-corrupt')).toHaveText(
    `Records this device cannot read, which are not carried over: ${String(items + envelopes)}.`,
  );
});
