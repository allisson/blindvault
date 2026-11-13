import { type Page, expect, test } from '@playwright/test';

import { createVault } from './create';

// The item detail (D247): a header with the avatar and chips, fields in titled cards, icon and text
// on a secret's buttons and icon buttons on the others (D254), Duplicate, History and Move to trash
// under "More actions", and a shown seed phrase as a numbered grid.

test.setTimeout(120_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';
const PHRASE = `${Array(11).fill('abandon').join(' ')} about`;

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

async function newItem(page: Page, template: string, title: string) {
  await button(page, 'New item').click();
  await button(page, template).click();
  await page.getByTestId('item-title').fill(title);
}

test('the detail shows chips, titled cards and the actions menu (D247)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await createVault(page, PASSWORD);

  await newItem(page, 'Login', 'Harbor Credit Union');
  await page.getByTestId('input-Username').fill('ana.lima');
  await page.getByTestId('input-Password').fill('Tulip-Orbit-5528-Granite');
  await page.getByTestId('input-Website').fill('https://bank.example/login');
  await page.getByLabel('Tags').fill('bank, family');
  await page.getByTestId('add-field-type').selectOption('text');
  await button(page, 'Add').click();
  await page.getByTestId('custom-label').fill('Branch');
  await page.getByTestId('input-Branch').fill('0042');
  await page.getByLabel('Notes').fill('Call before noon.');
  await button(page, 'Save').click();

  const article = page.getByRole('article');
  await expect(
    article.getByRole('heading', { name: 'Harbor Credit Union', level: 1 }),
  ).toBeVisible();
  const chips = article.getByRole('listitem');
  await expect(chips).toHaveText(['Login', 'bank.example', 'bank', 'family']);
  // A tag's icon says what the chip is; the template's and the host's text says it already.
  await expect(chips.nth(2).getByRole('img', { name: 'Tags' })).toBeVisible();
  await expect(chips.first().getByRole('img')).toHaveCount(0);

  // The template's fields, the user's own and the notes, each in a titled card.
  for (const title of ['Login', 'Other fields', 'Notes']) {
    await expect(article.getByRole('region', { name: title, exact: true })).toBeVisible();
  }
  await expect(
    article.getByRole('region', { name: 'Other fields', exact: true }).getByText('0042'),
  ).toBeVisible();

  // A secret's buttons carry an icon beside their visible text.
  await expect(button(page, 'Show').locator('svg')).toHaveCount(1);
  await expect(button(page, 'Copy: Password').locator('svg')).toHaveCount(1);
  // Other fields: Copy and Open are icon buttons, named and with a tooltip (D254).
  const copyUser = button(page, 'Copy: Username');
  await expect(copyUser).toHaveAttribute('title', 'Copy');
  await expect(copyUser).toHaveText('');
  await expect(page.getByRole('link', { name: 'Open: Website', exact: true })).toHaveAttribute(
    'href',
    'https://bank.example/login',
  );

  // Edit is visible; the rest waits under More actions.
  await expect(button(page, 'Edit')).toBeVisible();
  await expect(button(page, 'Duplicate')).toHaveCount(0);
  await button(page, 'More actions').click();
  const menu = page.locator(':popover-open');
  for (const name of ['Duplicate', 'History', 'Move to trash']) {
    await expect(menu.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await page.keyboard.press('Escape');
  await expect(button(page, 'Duplicate')).toHaveCount(0);
  // History is also a link at the detail's foot (D254).
  await expect(button(page, 'History')).toBeVisible();
});

test('a shown seed phrase is a numbered grid of its words (D247)', async ({ page }) => {
  await page.goto('/');
  await createVault(page, PASSWORD);
  await newItem(page, 'Crypto wallet', 'Cold wallet');
  await page.getByTestId('input-Seed phrase').fill(PHRASE);
  await button(page, 'Save').click();
  const secret = page.getByTestId('secret-Seed phrase');
  await expect(secret.getByRole('listitem')).toHaveCount(0);
  await secret.locator('..').getByRole('button', { name: 'Show', exact: true }).click();
  const words = secret.getByRole('listitem');
  await expect(words).toHaveCount(12);
  await expect(words.first()).toHaveText('1abandon');
  await expect(words.last()).toHaveText('12about');
});
