// Keyboard alone (WCAG 2.1.1, UX Gate): a vault created, an item made with the generator, copied,
// edited and its edit discarded through the dialog, its history, Settings, a lock and an unlock,
// each control reached with Tab and pressed with Enter or Space, at the three layout widths.

import { type Locator, type Page, expect, test } from '@playwright/test';

import { WIDTHS } from './axe';
import { createVault } from './create';
import { lock } from './lock';

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
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    // On a phone, Lock is in the "…" menu (D245).
    if (await button(page, 'More').isVisible()) await press(page, button(page, 'More'));
    await press(page, button(page, 'Lock'));
    await type(page, page.getByTestId('unlock-password'), PASSWORD);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });
  });
}

for (const [layout, width] of WIDTHS) {
  test(`the Preview badge, the row's Copy, the pills, the "…" menu and Show password work from the keyboard, ${layout} (D245, D246, D254)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await createVault(page, PASSWORD);
    const settings = page.getByRole('button', { name: 'Settings' }).first();
    const toList = async () => {
      while (!(await settings.isVisible())) await button(page, 'Back').click();
    };

    // A popover opens with Enter and closes with Esc, handing the focus back to its button.
    const badge = page.getByTestId('preview-badge');
    await press(page, badge);
    await expect(page.getByTestId('preview-banner')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('preview-banner')).toBeHidden();
    await expect(badge).toBeFocused();

    for (const [type, title] of [
      ['Login', 'Harbor'],
      ['Secure note', 'Memo'],
    ] as const) {
      await toList();
      await button(page, 'New item').click();
      await button(page, type).click();
      await page.getByTestId('item-title').fill(title);
      if (type === 'Login') await page.getByTestId('input-Password').fill('Tulip-Orbit-5528');
      await button(page, 'Save').click();
      await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
    }

    // The "…" menu: Tab reaches its actions, Esc closes it.
    const more = button(page, 'More actions');
    await press(page, more);
    await tabTo(page, button(page, 'Move to trash'));
    await page.keyboard.press('Escape');
    await expect(button(page, 'Move to trash')).toBeHidden();
    await expect(more).toBeFocused();

    // The row's Copy, announced by the toast.
    await toList();
    await press(page, button(page, 'Copy password: Harbor'));
    await expect(page.getByTestId('toast-region')).toContainText('Copied.');

    // The type pill: Esc closes it; a choice applies and closes it.
    const pill = page.getByTestId('type-pill');
    const types = page.getByRole('group', { name: 'Filter by type' });
    await press(page, pill);
    await expect(types).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(types).toBeHidden();
    await expect(pill).toBeFocused();
    await press(page, pill);
    await press(page, types.getByRole('button', { name: 'Secure note', exact: true }));
    await expect(types).toBeHidden();
    await expect(pill).toHaveText('Secure note');
    await expect(button(page, 'Harbor')).toHaveCount(0);

    // On a phone, the folders' bottom sheet.
    if (layout === 'mobile') {
      const folders = page.getByTestId('folder-pill');
      await press(page, folders);
      await expect(page.getByRole('navigation', { name: 'Folders' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('navigation', { name: 'Folders' })).toBeHidden();
      await expect(folders).toBeFocused();
    }

    // Show password: Space shows it, and the button says so.
    await lock(page);
    const field = page.getByTestId('unlock-password');
    await type(page, field, PASSWORD);
    await press(page, button(page, 'Show password'), 'Space');
    await expect(field).toHaveAttribute('type', 'text');
    await expect(button(page, 'Hide password')).toHaveAttribute('aria-pressed', 'true');
    await press(page, field);
    await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });
  });
}

for (const [layout, width] of WIDTHS) {
  test(`the list moves with the arrows and J/K, the search clears with Esc, Ctrl/⌘+Enter saves and the slider sets the length, ${layout} (D251)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await createVault(page, PASSWORD);
    // On a phone, the list waits behind Back from an item.
    const settings = page.getByRole('button', { name: 'Settings' }).first();
    const toList = async () => {
      while (!(await settings.isVisible())) await button(page, 'Back').click();
    };

    // Ctrl/⌘ + Enter saves from the notes, where Enter alone is a new line.
    for (const title of ['Charlie', 'Alpha', 'Bravo']) {
      await toList();
      await button(page, 'New item').click();
      await button(page, 'Login').click();
      await page.getByTestId('item-title').fill(title);
      await page.getByTestId('item-notes').fill('note');
      await page.getByTestId('item-notes').press('ControlOrMeta+Enter');
      await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
    }
    await expect(button(page, 'Save')).toHaveCount(0);
    await toList();

    const search = page.getByTestId('search');
    const row = (name: string) => button(page, name);
    await page.keyboard.press('ControlOrMeta+k');
    await expect(search).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(row('Alpha')).toBeFocused();
    await page.keyboard.press('j');
    await expect(row('Bravo')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(row('Charlie')).toBeFocused();
    // Past the last row, the focus stays.
    await page.keyboard.press('ArrowDown');
    await expect(row('Charlie')).toBeFocused();
    await page.keyboard.press('k');
    await expect(row('Bravo')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Bravo', level: 1 })).toBeVisible();
    await toList();
    await row('Bravo').focus();
    await page.keyboard.press('ArrowUp');
    await expect(row('Alpha')).toBeFocused();
    // Above the first row is the search.
    await page.keyboard.press('ArrowUp');
    await expect(search).toBeFocused();

    // Esc clears the search and keeps the focus in it.
    await page.keyboard.type('zzz');
    await expect(page.getByText('No items match.')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(search).toHaveValue('');
    await expect(search).toBeFocused();
    await expect(row('Alpha')).toBeVisible();

    // The slider and the field set the same length.
    await button(page, 'New item').click();
    await button(page, 'Login').click();
    await button(page, 'Generate').click();
    const slider = page.getByTestId('generator-length-slider');
    const field = page.getByRole('textbox', { name: 'Length (12–128)' });
    await expect(field).toHaveValue('20');
    await slider.focus();
    await page.keyboard.press('ArrowRight');
    await expect(field).toHaveValue('21');
    await page.keyboard.press('End');
    await expect(field).toHaveValue('128');
    await field.fill('40');
    await expect(slider).toHaveValue('40');
    await expect(page.getByTestId('generator-entropy')).toHaveText('262 bits of entropy');
  });
}
