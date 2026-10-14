// The fill helper itself: it passes when the value lands, and fails at once, saying why, when the
// field is recreated or the focus moves between Playwright's focus and its typing.

import { expect, test } from '@playwright/test';

import { fillPassword } from './password';

const VALUE = 'quartz-lantern-velvet-harbor-9214';

const PAGE = `<!doctype html><meta charset="utf-8">
<input data-testid="field" type="password">
<input data-testid="other" type="text">`;

test('fills a password field and checks the value landed', async ({ page }) => {
  await page.setContent(PAGE);
  const field = page.getByTestId('field');
  await fillPassword(field, VALUE);
  await expect(field).toHaveValue(VALUE);
  expect(await page.evaluate(() => '__fillPassword' in window)).toBe(false);
});

test('fails at once when the field is recreated after it was focused', async ({ page }) => {
  await page.setContent(PAGE);
  await page.evaluate(() => {
    const field = document.querySelector('[data-testid="field"]');
    field?.addEventListener(
      'focus',
      () => {
        queueMicrotask(() => {
          field.replaceWith(field.cloneNode());
        });
      },
      { once: true },
    );
  });
  const error = await fillPassword(page.getByTestId('field'), VALUE).catch((e: unknown) => e);
  expect(String(error)).toContain('the field was recreated');
  expect(String(error)).not.toContain(VALUE);
});

test('fails at once when the focus moves after the field was focused', async ({ page }) => {
  await page.setContent(PAGE);
  await page.evaluate(() => {
    const field = document.querySelector('[data-testid="field"]');
    const other = document.querySelector<HTMLInputElement>('[data-testid="other"]');
    field?.addEventListener(
      'focus',
      () => {
        queueMicrotask(() => {
          other?.focus();
        });
      },
      { once: true },
    );
  });
  const error = await fillPassword(page.getByTestId('field'), VALUE).catch((e: unknown) => e);
  expect(String(error)).toContain('the focus moved to INPUT[data-testid="other"]');
  expect(String(error)).not.toContain(VALUE);
});
