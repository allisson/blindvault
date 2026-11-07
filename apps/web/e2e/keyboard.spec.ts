// Keyboard alone (WCAG 2.1.1, UX Gate): a vault created, an item made with the generator, copied,
// edited and its edit discarded through the dialog, its history, Settings, a lock and an unlock,
// each control reached with Tab and pressed with Enter or Space, at the three layout widths.

import { type Locator, type Page, expect, test } from '@playwright/test';

import { WIDTHS } from './axe';

// Creating a vault calibrates Argon2id at about 1 s (D9), and the unlock runs it again.
test.setTimeout(180_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';

test.beforeEach(async ({ page }) => {
  // The clipboard write succeeds the same way in every browser (see totp.spec.ts).
  await page.addInitScript(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', { value: () => Promise.resolve() });
  });
});

/** Presses Tab until `target` has the focus, failing past `limit` presses. */
async function tabTo(page: Page, target: Locator, limit = 60): Promise<void> {
  // Safari reaches buttons with Tab only under its "Press Tab to highlight" setting; Option+Tab
  // always does.
  const tab = test.info().project.name === 'webkit' ? 'Alt+Tab' : 'Tab';
  let key = tab;
  for (let n = 0; n < limit; n++) {
    if (await target.evaluate((e) => e === document.activeElement)) return;
    const before = await page.evaluateHandle(() => document.activeElement);
    await page.keyboard.press(key);
    // Past the last control, Firefox hands Tab to the browser's own UI, which headless never
    // gives back: go the other way, as a user would with Shift+Tab.
    if (await before.evaluate((e) => e === document.activeElement)) key = `Shift+${tab}`;
  }
  throw new Error(`Tab never reached ${target.toString()}`);
}

async function press(page: Page, target: Locator, key = 'Enter'): Promise<void> {
  await tabTo(page, target);
  await page.keyboard.press(key);
}

async function type(page: Page, target: Locator, text: string): Promise<void> {
  await tabTo(page, target);
  await page.keyboard.type(text);
}

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

for (const [layout, width] of WIDTHS) {
  test(`every step of the main flow completes with the keyboard alone, ${layout}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');

    // WebKit is Safari in a plain tab, where the first screen advises installing the app (D198).
    const advice = button(page, 'Continue in this tab');
    await expect(advice.or(button(page, 'Create a new vault'))).toBeVisible();
    if (await advice.isVisible()) await press(page, advice);

    // Creation: the phrase, its confirmation, the local password.
    await press(page, button(page, 'Create a new vault'));
    await expect(page.getByTestId('recovery-phrase')).toBeVisible();
    const words: string[] = [];
    for (let n = 1; n <= 24; n++) {
      words.push((await page.getByTestId(`phrase-word-${String(n)}`).textContent()) ?? '');
    }
    await press(page, button(page, 'I wrote them down'));
    const fields = page.locator('[data-testid^="confirm-word-"]');
    await expect(fields).toHaveCount(3);
    for (const field of await fields.all()) {
      const n = Number((await field.getAttribute('data-testid'))?.replace('confirm-word-', ''));
      await type(page, field, words[n - 1] ?? '');
    }
    await press(page, button(page, 'Confirm'));
    await type(page, page.getByTestId('new-password'), PASSWORD);
    await type(page, page.getByTestId('confirm-password'), PASSWORD);
    await press(page, button(page, 'Create vault'));
    await expect(page.getByTestId('ready')).toBeVisible({ timeout: 60_000 });
    await press(page, button(page, 'Open the vault'));

    // An item: the type, the generator, a save, a copy.
    await press(page, button(page, 'New item'));
    await press(page, button(page, 'Login'));
    await type(page, page.getByTestId('item-title'), 'Harbor');
    await press(page, button(page, 'Generate'));
    // The mode is a radio group: one Tab stop, the arrows move the choice.
    const entropy = page.getByTestId('generator-entropy');
    await tabTo(page, page.getByLabel('Characters', { exact: true }));
    await page.keyboard.press('ArrowDown');
    await expect(page.getByLabel('Words', { exact: true })).toBeChecked();
    await expect(entropy).toHaveText('66 bits of entropy');
    await page.keyboard.press('ArrowUp');
    await expect(entropy).toHaveText('131 bits of entropy');
    await press(page, button(page, 'Use this password'));
    await expect(page.getByTestId('input-Password')).toHaveValue(/^.{20}$/);
    await press(page, button(page, 'Save'));
    await expect(page.getByRole('heading', { name: 'Harbor', level: 1 })).toBeVisible();
    const copy = button(page, 'Copy: Password');
    await press(page, copy, 'Space');
    await expect(copy.getByTestId('copy-check')).toBeVisible();

    // An edit discarded through the dialog, then the history.
    await press(page, button(page, 'Edit'));
    await type(page, page.getByTestId('item-title'), ' Bank');
    await press(page, button(page, 'Cancel'));
    await expect(page.getByTestId('discard-confirm')).toBeVisible();
    await press(page, button(page, 'Discard the changes'));
    await expect(page.getByRole('heading', { name: 'Harbor', level: 1 })).toBeVisible();
    await press(page, button(page, 'History'));
    await expect(page.getByRole('heading', { name: 'History' }).first()).toBeVisible();

    // Settings (on mobile, behind Back from the history and the item), a lock and an unlock.
    const settings = page.getByRole('button', { name: 'Settings' }).first();
    while (!(await settings.isVisible())) await press(page, button(page, 'Back'));
    await press(page, settings);
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    await press(page, button(page, 'Lock'));
    await type(page, page.getByTestId('unlock-password'), PASSWORD);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });
  });
}
