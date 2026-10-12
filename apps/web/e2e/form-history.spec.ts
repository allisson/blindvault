import { type Page, expect, test } from '@playwright/test';

// Calibrating Argon2id targets about 1 s per derivation (D9), on every browser.
test.setTimeout(180_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';

function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

/**
 * Every text control on the page that the browser may keep in its form history: those without
 * `autocomplete="off"`. Only the local password fields name their purpose instead (D174).
 */
async function kept(page: Page): Promise<{ readonly count: number; readonly kept: string[] }> {
  return page.evaluate(() => {
    const passwords = new Set(['current-password', 'new-password']);
    const controls = [...document.querySelectorAll('input, textarea')].filter(
      (e) => !(e instanceof HTMLInputElement) || !['checkbox', 'radio', 'hidden'].includes(e.type),
    );
    const out = controls.filter((e) => {
      const value = e.getAttribute('autocomplete');
      if (value === 'off') return false;
      return !(
        e instanceof HTMLInputElement &&
        e.type === 'password' &&
        passwords.has(value ?? '')
      );
    });
    return {
      count: controls.length,
      kept: out.map((e) => e.getAttribute('data-testid') ?? e.getAttribute('aria-label') ?? e.id),
    };
  });
}

async function expectNoneKept(page: Page) {
  const result = await kept(page);
  expect(result.count).toBeGreaterThan(0);
  expect(result.kept).toEqual([]);
}

test('keeps vault content out of the browser form history (D174, CRYPTO-INV-001)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('new-password')).toBeVisible();
  await expectNoneKept(page);
  await page.getByTestId('new-password').fill(PASSWORD);
  await page.getByTestId('confirm-password').fill(PASSWORD);
  await button(page, 'Create vault').click();
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });
  await expectNoneKept(page);

  // The folder forms: new folder, new subfolder, rename.
  await button(page, '+ New folder').click();
  await expectNoneKept(page);
  await page.getByTestId('folder-name').fill('Work');
  await button(page, 'Create').click();
  await expect(page.getByRole('heading', { name: 'Work', level: 2 })).toBeVisible();
  for (const action of ['New subfolder', 'Rename']) {
    await button(page, action).click();
    await expectNoneKept(page);
    await button(page, action).first().click();
  }

  // The editor of every template, with one field of every type added and the generator open.
  await button(page, 'New item').click();
  const templates = await page
    .getByRole('region', { name: 'Details' })
    .getByRole('listitem')
    .getByRole('button')
    .allTextContents();
  expect(templates.length).toBeGreaterThan(0);
  const types = await (async () => {
    await button(page, templates[0] ?? '').click();
    return page
      .getByTestId('add-field-type')
      .locator('option')
      .evaluateAll((o) => o.map((e) => (e as HTMLOptionElement).value));
  })();
  expect(types.length).toBeGreaterThan(0);
  for (const [i, template] of templates.entries()) {
    if (i > 0) {
      await button(page, 'New item').click();
      await button(page, template).click();
    }
    for (const type of types) {
      await page.getByTestId('add-field-type').selectOption(type);
      await button(page, 'Add').click();
    }
    await button(page, 'Generate').first().click();
    await expectNoneKept(page);
    await button(page, 'Cancel').click();
  }

  // Search, then Settings: only the password fields name their purpose.
  await page.getByTestId('search').fill('harbor');
  await expectNoneKept(page);
  await page.getByTestId('search').fill('');
  await button(page, 'Settings').click();
  await expectNoneKept(page);
});

test('finds a text control the form history may keep', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.dataset.testid = 'planted';
    document.body.append(input);
  });
  expect((await kept(page)).kept).toEqual(['planted']);
});
