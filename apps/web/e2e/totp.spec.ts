import { createHmac } from 'node:crypto';

import { type Page, expect, test } from '@playwright/test';

import { createVault } from './create';

// Calibrating Argon2id targets about 1 s per derivation (D9), on every browser.
test.setTimeout(120_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';
// The RFC 6238 SHA1 key, "12345678901234567890", in base32.
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const URI = `otpauth://totp/ACME:ana@acme.example?secret=${SECRET}&issuer=ACME`;

/** RFC 6238 SHA1, 6 digits, 30 s: computed here, apart from the app's code. */
function code(step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', Buffer.from('12345678901234567890')).update(counter).digest();
  const offset = (mac.at(-1) ?? 0) & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

function codesAround(nowMs: number): string[] {
  const step = Math.floor(nowMs / 30_000);
  return [code(step - 1), code(step), code(step + 1)];
}

async function create(page: Page) {
  await page.goto('/');
  await createVault(page, PASSWORD);
}

function writes(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { clipboardWrites: string[] }).clipboardWrites);
}

test.beforeEach(async ({ page }) => {
  // Records what the app writes to the clipboard, the same way in every browser: reading the
  // real clipboard back needs a permission only Chromium grants to tests.
  await page.addInitScript(() => {
    const log: string[] = [];
    Object.defineProperty(window, 'clipboardWrites', { value: log });
    Object.defineProperty(navigator.clipboard, 'writeText', {
      value: (text: string) => {
        log.push(text);
        return Promise.resolve();
      },
    });
  });
});

test('adds a TOTP field from an otpauth:// link, masks its TOTP secret and shows the code (D127)', async ({
  page,
}) => {
  await create(page);
  await page.getByRole('button', { name: 'New item', exact: true }).click();
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await page.getByTestId('item-title').fill('ACME');
  await page.getByTestId('add-field-type').selectOption('totp');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByTestId('custom-label').fill('2FA');
  // The link holds the TOTP secret: typed into a masked input.
  await expect(page.getByTestId('input-2FA')).toHaveAttribute('type', 'password');
  await page.getByTestId('input-2FA').fill('otpauth://totp/x?secret=JBSWY3DP&digits=4');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(/Paste an otpauth:\/\/totp\/ link/)).toBeVisible();
  await page.getByTestId('input-2FA').fill(URI);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ACME', exact: true })).toBeVisible();

  // The TOTP secret is masked by default, the current code shown (overview §13.2).
  await expect(page.getByTestId('secret-2FA')).toHaveText('••••••••');
  await expect(page.getByText(SECRET)).toHaveCount(0);
  await expect(page.getByText('ACME · ana@acme.example')).toBeVisible();
  const shown = page.getByTestId('totp-2FA');
  await expect(shown).toHaveText(/^[0-9]{3} [0-9]{3}$/);
  const digits = (await shown.innerText()).replace(' ', '');
  expect(codesAround(Date.now())).toContain(digits);
  await expect(page.getByTestId('totp-expires-2FA')).toHaveText(
    /^Changes in ([1-9]|[12][0-9]|30) s$/,
  );

  // Kept as stored on an edit that leaves the field empty (D165).
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByText(/Leave empty to keep the current TOTP secret/)).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('totp-2FA')).toHaveText(/^[0-9]{3} [0-9]{3}$/);
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  await expect(page.getByTestId('secret-2FA')).toHaveText(SECRET);
});

test('copies a TOTP code and a secret, then clears the clipboard after the timeout and on lock (D54, D127)', async ({
  page,
}) => {
  await create(page);
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByTestId('clipboardClearSeconds').fill('10');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back', exact: true }).click();

  await page.getByRole('button', { name: 'New item', exact: true }).click();
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await page.getByTestId('item-title').fill('ACME');
  await page.getByTestId('input-Password').fill('Tulip-Orbit-5528-Granite');
  await page.getByTestId('add-field-type').selectOption('totp');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByTestId('custom-label').fill('2FA');
  await page.getByTestId('input-2FA').fill(SECRET.toLowerCase());
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('totp-2FA')).toHaveText(/^[0-9]{3} [0-9]{3}$/);
  expect(await writes(page)).toEqual([]);

  // Copying takes an explicit action and says that clearing is not guaranteed.
  await page.getByRole('button', { name: 'Copy code: 2FA', exact: true }).click();
  await expect(page.getByText(/clear the clipboard in 10 s .* not guaranteed/)).toBeVisible();
  const copied = await writes(page);
  expect(copied).toHaveLength(1);
  expect(codesAround(Date.now())).toContain(copied[0]);
  await expect.poll(() => writes(page), { timeout: 15_000 }).toEqual([copied[0], '']);

  // The secret is copied without being shown, and cleared on lock before its timeout.
  await page.getByRole('button', { name: 'Copy: Password', exact: true }).click();
  await expect(page.getByTestId('secret-Password')).toHaveText('••••••••');
  expect((await writes(page)).at(-1)).toBe('Tulip-Orbit-5528-Granite');
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await expect(page.getByTestId('unlock-password')).toBeVisible();
  await expect.poll(() => writes(page)).toEqual([copied[0], '', 'Tulip-Orbit-5528-Granite', '']);
});
