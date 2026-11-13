import { expect, test } from '@playwright/test';

import { createVault } from './create';

// WCAG 2.2 AA (overview §13.7, D237): what a screen reader gets from the item editor and view.

// Calibrating Argon2id targets about 1 s per derivation (D9), on every browser.
test.setTimeout(120_000);

const TOTP = 'JBSWY3DPEHPK3PXP';

test('names the generator, describes a field by its error, and reads a mask and a TOTP code as words (D237)', async ({
  page,
}) => {
  await page.goto('/');
  await createVault(page, 'quartz-lantern-velvet-harbor-9214');
  await page.getByRole('button', { name: 'New item', exact: true }).click();
  await page.getByRole('button', { name: 'Login', exact: true }).click();

  // The generator is a named group.
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Password generator' })).toBeVisible();
  await page.keyboard.press('Escape');

  // A refused value: the field's error is its description.
  await page.getByTestId('item-title').fill('ACME');
  await page.getByTestId('input-Password').fill('Tulip-Orbit-5528-Granite');
  await page.getByTestId('add-field-type').selectOption('totp');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByTestId('custom-label').fill('2FA');
  const totp = page.getByTestId('input-2FA');
  await totp.fill(`otpauth://totp/x?secret=${TOTP}&digits=4`);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const error = page.getByRole('alert').filter({ hasText: /digit/ });
  await expect(error).toBeVisible();
  await expect(totp).toHaveAccessibleDescription((await error.textContent()) ?? '');
  await totp.fill(TOTP);
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  // The view: a mask is "Hidden", not dots; the code has a label a screen reader reaches.
  await expect(page.getByTestId('totp-2FA')).toHaveText(/^[0-9]{3} [0-9]{3}$/);
  await expect(page.getByTestId('secret-Password')).toHaveText('••••••••Hidden');
  await expect(page.getByTestId('secret-Password').locator('[aria-hidden="true"]')).toHaveText(
    '••••••••',
  );
  await expect(page.getByText('Current code', { exact: true })).toBeAttached();
});

test('reflows at 320 px with no horizontal scroll: start, list, editor and Settings, in both languages (WCAG 1.4.10, D237)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  await page.goto('/');
  await createVault(page, 'quartz-lantern-velvet-harbor-9214');
  expect(await fits()).toBe(true);
  await page.getByRole('button', { name: 'New item', exact: true }).click();
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  expect(await fits()).toBe(true);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  expect(await fits()).toBe(true);
  // Longer labels in Brazilian Portuguese.
  await page.getByTestId('settings-language').click();
  await page.getByRole('combobox', { name: 'Language' }).selectOption('pt-BR');
  await expect(page.getByRole('heading', { name: 'Idioma', level: 1 })).toBeVisible();
  expect(await fits()).toBe(true);
  // The densest pages, in Portuguese too.
  await page.getByRole('button', { name: 'Voltar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Configurações', level: 1 })).toBeVisible();
  expect(await fits()).toBe(true);
  for (const row of ['devices', 'backup']) {
    await page.getByTestId(`settings-${row}`).click();
    expect(await fits()).toBe(true);
    await page.getByRole('button', { name: 'Voltar', exact: true }).click();
  }
});
