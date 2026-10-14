import { type Page, expect, test } from '@playwright/test';

import { answerConfirmation, openVault, readPhrase } from './create';

// Calibrating Argon2id targets about 1 s per derivation (D9), on every browser.
test.setTimeout(180_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';
// Shown wherever a local password is set, since a browser can save it next to the vault (D175).
const BROWSER_SAVE = /Do not let the browser save this password/;

function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

/**
 * Every text control on the page that the browser may keep in its form history (without
 * `autocomplete="off"`; only the local password fields name their purpose instead, D174), and
 * every one it may spellcheck, which can send the text to a remote service (D176).
 */
async function kept(
  page: Page,
): Promise<{ readonly count: number; readonly kept: string[]; readonly spelled: string[] }> {
  return page.evaluate(() => {
    const passwords = new Set(['current-password', 'new-password']);
    const controls = [...document.querySelectorAll('input, textarea')].filter(
      (e) => !(e instanceof HTMLInputElement) || !['checkbox', 'radio', 'hidden'].includes(e.type),
    );
    const name = (e: Element) =>
      e.getAttribute('data-testid') ?? e.getAttribute('aria-label') ?? e.id;
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
      kept: out.map(name),
      spelled: controls.filter((e) => e.getAttribute('spellcheck') !== 'false').map(name),
    };
  });
}

async function expectNoneKept(page: Page) {
  const result = await kept(page);
  expect(result.count).toBeGreaterThan(0);
  expect(result.kept).toEqual([]);
  expect(result.spelled).toEqual([]);
}

test('keeps vault content out of the form history and the spellchecker (D174, D176, CRYPTO-INV-001), and warns against saving the password (D175)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  // Creation: the phrase confirmation fields, then the password step (D179).
  const words = await readPhrase(page);
  await button(page, 'I wrote them down').click();
  await expect(page.locator('[data-testid^="confirm-word-"]')).toHaveCount(3);
  await expectNoneKept(page);
  await answerConfirmation(page, words);
  await expect(page.getByTestId('new-password')).toBeVisible();
  await expectNoneKept(page);
  await expect(page.getByText(BROWSER_SAVE)).toBeVisible();
  await page.getByTestId('new-password').fill(PASSWORD);
  await page.getByTestId('confirm-password').fill(PASSWORD);
  await button(page, 'Create vault').click();
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });
  await expectNoneKept(page);
  await openVault(page);

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
  await expect(page.getByText(BROWSER_SAVE)).toBeVisible();
  // The export password fields, with a generated passphrase shown as text (D181).
  await page.getByTestId('backup-protect').check();
  await button(page, 'Generate a passphrase').click();
  await expectNoneKept(page);
});

test('finds a text control the form history may keep, or the browser may spellcheck', async ({
  page,
}) => {
  await page.goto('/');
  await page.evaluate(() => {
    const kept = document.createElement('input');
    kept.dataset.testid = 'kept';
    kept.spellcheck = false;
    const spelled = document.createElement('textarea');
    spelled.dataset.testid = 'spelled';
    spelled.autocomplete = 'off';
    document.body.append(kept, spelled);
  });
  const result = await kept(page);
  expect(result.kept).toContain('kept');
  expect(result.kept).not.toContain('spelled');
  expect(result.spelled).toContain('spelled');
  expect(result.spelled).not.toContain('kept');
});
