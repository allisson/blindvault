import { type Request, expect, test } from '@playwright/test';

import { createVault } from './create';

// Calibrating Argon2id targets about 1 s per derivation (D9); this test derives five times.
test.setTimeout(180_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';
const NEXT = 'marble-compass-ember-tundra-5813';

/** Code: a script, a worker or WebAssembly. The browser fetches `sw.js` on its own (D162). */
function isCode(request: Request): boolean {
  const { pathname } = new URL(request.url());
  if (pathname === '/sw.js') return false;
  return request.resourceType() === 'script' || /\.(m?js|wasm)$/.test(pathname);
}

test('loads no script, worker or WebAssembly after the first unlock (D142)', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await createVault(page, PASSWORD);
  // A fresh window: creating the vault already used the strength check and the Argon2id worker.
  await page.reload();
  await page.getByTestId('unlock-password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });

  const late: string[] = [];
  context.on('request', (request) => {
    if (isCode(request)) late.push(request.url());
  });

  // The strength check and two derivations.
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByTestId('current-password').fill(PASSWORD);
  await page.getByTestId('new-password').fill(NEXT);
  await page.getByTestId('confirm-password').fill(NEXT);
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByText('Password changed.')).toBeVisible({ timeout: 30_000 });

  // An export under an export password: its strength check and two more derivations.
  await page.getByTestId('backup-protect').check();
  await page.getByTestId('backup-password').fill(NEXT);
  await page.getByRole('button', { name: 'Generate a passphrase', exact: true }).click();
  const passphrase = await page.getByTestId('export-password').inputValue();
  await page.getByTestId('export-password').fill(`${passphrase}x`);
  await page.getByTestId('export-confirm').fill(`${passphrase}x`);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.getByRole('button', { name: 'Export', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.bvault$/);

  expect(late).toEqual([]);
});
