// Automated accessibility checks (overview §13.7, D238): axe-core on every screen a single device
// reaches, in both themes, at the three layout widths. The screens a second device opens (the
// SAS comparison, a live sync) are left to the pairing and sync specs and the manual UX Gate run.

import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';

import { answerConfirmation, openVault, readPhrase, startScreen } from './create';

// Creating a vault calibrates Argon2id at about 1 s (D9); each test also runs axe on every screen.
test.setTimeout(240_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';
const WIDTHS = [
  ['mobile', 375],
  ['tablet', 800],
  ['desktop', 1280],
] as const;
const THEMES = ['light', 'dark'] as const;

/** WCAG 2.2 A and AA, the target of §13.7 (D231). */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function audit(page: Page, screen: string): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const found = violations.flatMap((v) =>
    v.nodes.map(
      (n) => `${v.id} (${v.impact ?? 'n/a'}): ${n.target.join(' ')}: ${n.failureSummary ?? ''}`,
    ),
  );
  expect(found, `axe on ${screen}`).toEqual([]);
}

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

for (const [layout, width] of WIDTHS) {
  for (const theme of THEMES) {
    test(`axe finds no violation on any screen, ${layout}, ${theme} theme (D238)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      // The theme follows the system by default (D232). Reduced motion measures each screen at
      // rest, not halfway through its entrance (D236).
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await page.goto('/');

      // WebKit is Safari in a plain tab, where the first screen advises installing the app (D198).
      const advice = button(page, 'Continue in this tab');
      await expect(advice.or(button(page, 'Create a new vault'))).toBeVisible();
      if (await advice.isVisible()) await audit(page, 'the install advice');
      await startScreen(page);
      await audit(page, 'the start');
      await button(page, 'About').click();
      await expect(page.getByRole('heading', { name: 'About BlindVault' })).toBeVisible();
      await audit(page, 'About');
      await button(page, 'Back').click();

      await button(page, 'Pair with an existing device').click();
      await audit(page, 'joining a vault');
      await button(page, 'Back').click();
      await button(page, 'Restore from a backup').click();
      await audit(page, 'restoring a backup');
      await button(page, 'Cancel').click();

      // Creation: the phrase, its confirmation, the local password, Vault ready.
      const words = await readPhrase(page);
      await audit(page, 'the Recovery Phrase');
      await button(page, 'I wrote them down').click();
      await audit(page, 'the phrase confirmation');
      await answerConfirmation(page, words);
      await expect(page.getByTestId('new-password')).toBeVisible();
      await audit(page, 'the local password');
      await page.getByTestId('new-password').fill(PASSWORD);
      await page.getByTestId('confirm-password').fill(PASSWORD);
      await audit(page, 'the local password, filled');
      await button(page, 'Create vault').click();
      await expect(page.getByTestId('ready')).toBeVisible({ timeout: 60_000 });
      await audit(page, 'Vault ready');
      await openVault(page);
      await audit(page, 'the empty vault');

      // Items: the type choice, the editor with the generator, a refused field, the view, history.
      await button(page, 'New item').click();
      await audit(page, 'the item type choice');
      await button(page, 'Login').click();
      await button(page, 'Generate').click();
      await audit(page, 'the item editor and the generator');
      await button(page, 'Save').click();
      await expect(page.getByText('Enter a title.')).toBeVisible();
      await audit(page, 'the item editor with an error');
      await page.getByTestId('item-title').fill('Harbor');
      await page.getByTestId('input-Password').fill('Tulip-Orbit-5528-Granite');
      await button(page, 'Save').click();
      await expect(page.getByRole('heading', { name: 'Harbor', level: 1 })).toBeVisible();
      await audit(page, 'an item');
      await button(page, 'Edit').click();
      await page.getByTestId('input-Password').fill('Tulip-Orbit-5528-Basalt');
      await button(page, 'Cancel').click();
      await audit(page, 'the discard confirmation');
      await button(page, 'Discard the changes').click();
      await button(page, 'History').click();
      await audit(page, 'an item history');

      // Settings, with About in it (D192).
      // On mobile, Settings waits on the list screen, behind Back from the history and the item.
      const settings = page.getByRole('button', { name: 'Settings' }).first();
      while (!(await settings.isVisible())) await button(page, 'Back').click();
      await settings.click();
      await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
      await audit(page, 'Settings');

      // Locked: unlock, and the forgotten password.
      await button(page, 'Lock').click();
      await expect(page.getByTestId('unlock-password')).toBeVisible();
      await audit(page, 'the unlock');
      await page.getByTestId('unlock-password').fill('wrong-password-1234');
      await button(page, 'Unlock').click();
      await expect(page.getByText('Wrong password.')).toBeVisible({ timeout: 30_000 });
      await audit(page, 'the unlock with an error');
      await button(page, 'Forgot the password?').click();
      await audit(page, 'the forgotten password');
    });
  }
}
