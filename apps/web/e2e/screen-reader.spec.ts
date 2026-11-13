// What a screen reader reads (UX Gate, D241): the accessibility tree of each screen of the main
// flow, the tree VoiceOver and NVDA read, compared with what the screen must say: each heading, each
// control by its role and name, a secret read as "Hidden", each error as an alert, the clipboard note
// as a status and the discard confirmation as a named dialog. The templates are partial: a node they
// leave out may be there, a node they list must be, in that order. Each runs at the three widths.

import { type Page, expect, test } from '@playwright/test';

import { WIDTHS } from './axe';
import { answerConfirmation, openVault, readPhrase, startScreen } from './create';
import { lock } from './lock';

// Creating a vault calibrates Argon2id at about 1 s (D9), and the unlock runs it again.
test.setTimeout(180_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

test.beforeEach(async ({ page }) => {
  // The clipboard write succeeds the same way in every browser (see totp.spec.ts).
  await page.addInitScript(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', { value: () => Promise.resolve() });
  });
});

for (const [layout, width] of WIDTHS) {
  test(`the main flow reads as it should to a screen reader, ${layout} (D241)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    const main = page.getByRole('main');

    await startScreen(page);
    await expect(main).toMatchAriaSnapshot(`
      - button "Preview"
      - heading "BlindVault" [level=1]
      - list:
        - listitem: /no account and no server/
        - listitem: /can reset your local password/
        - listitem: /Recovery Phrase and a backup/
      - button "Create a new vault"
      - button "Pair with an existing device"
      - button "Restore from a backup"
    `);

    const words = await readPhrase(page);
    await expect(main).toMatchAriaSnapshot(`
      - heading "Create a vault" [level=1]
      - heading "Your Recovery Phrase" [level=2]
      - list:
        - listitem: /^1\\. [a-z]+$/
        - listitem: /^24\\. [a-z]+$/
      - paragraph: /shown only now/
      - paragraph: /Do not take a screenshot/
      - button "I wrote them down"
    `);

    await button(page, 'I wrote them down').click();
    await expect(main).toMatchAriaSnapshot(`
      - heading "Confirm the Recovery Phrase" [level=1]
      - textbox /^Word \\d+$/
      - textbox /^Word \\d+$/
      - textbox /^Word \\d+$/
      - button "Confirm" [disabled]
    `);

    await answerConfirmation(page, words);
    await expect(page.getByTestId('new-password')).toBeVisible();
    await expect(main).toMatchAriaSnapshot(`
      - heading "Create a vault" [level=1]
      - textbox "Local password"
      - textbox "Repeat the password"
      - paragraph: /Do not let the browser save this password/
      - button "Create vault" [disabled]
    `);

    await page.getByTestId('new-password').fill(PASSWORD);
    await page.getByTestId('confirm-password').fill(PASSWORD);
    await button(page, 'Create vault').click();
    await expect(page.getByTestId('ready')).toBeVisible({ timeout: 60_000 });
    // The passkey step is left out: it shows only where the browser supports passkeys, and
    // WebKit on Linux does not.
    await expect(main).toMatchAriaSnapshot(`
      - region "Vault ready":
        - heading "Vault ready" [level=1]
        - list:
          - listitem:
            - button "Make a backup"
          - listitem:
            - button "Pair a device"
        - button "Open the vault"
    `);

    // The folder tree is left out: on a tablet it waits in its drawer, out of the tree (D197). So is
    // New item, which a phone has in its header (D245).
    await openVault(page);
    await expect(main).toMatchAriaSnapshot(`
      - region "Items":
        - heading "Items" [level=2]
        - searchbox "Search"
        - region "First steps":
          - heading "First steps" [level=3]
          - paragraph: "Your vault lives only on your devices. To start:"
          - list:
            - listitem:
              - img "Done"
              - text: Create the vault and keep its Recovery Phrase
            - listitem:
              - text: "Add your first item: a login, a card, a secure note…"
              - button "Add an item"
            - listitem:
              - text: Import from another password manager.
              - button "Import"
            - listitem:
              - text: Pair another device, so the vault has a second copy you can sync with.
              - button "Pair a device"
    `);

    // A refused save: the field is invalid and the reason is an alert, at the field and the button.
    await button(page, 'New item').click();
    await button(page, 'Login').click();
    await button(page, 'Save').click();
    await expect(page.getByText('Enter a title.')).toBeVisible();
    await expect(main).toMatchAriaSnapshot(`
      - region "Details":
        - heading "Login" [level=1]
        - textbox "Title" [invalid]
        - alert: Enter a title.
        - textbox "Password"
        - button "Show"
        - button "Generate"
        - alert: Fix the fields marked above.
        - button "Cancel"
        - button "Save"
    `);

    // An item: the secret is read as "Hidden", and a copy is announced with its clipboard note.
    await page.getByTestId('item-title').fill('Harbor');
    await page.getByTestId('input-Password').fill('Tulip-Orbit-5528-Granite');
    await button(page, 'Save').click();
    await expect(page.getByRole('heading', { name: 'Harbor', level: 1 })).toBeVisible();
    await expect(main).toMatchAriaSnapshot(`
      - region "Details":
        - article "Harbor":
          - heading "Harbor" [level=1]
          - list:
            - listitem: Login
          - button "Edit"
          - button "More actions"
          - region "Login":
            - heading "Login" [level=2]
            - term: Password
            - definition:
              - text: Hidden
              - button "Show"
              - 'button "Copy: Password"'
    `);
    await button(page, 'Copy: Password').click();
    await expect(page.locator('body')).toMatchAriaSnapshot(`
      - status:
        - paragraph: /clear the clipboard in \\d+ s .* not guaranteed/
    `);

    // The discard confirmation is a dialog named by its action.
    await button(page, 'Edit').click();
    await page.getByTestId('item-title').fill('Harbor Bank');
    await button(page, 'Cancel').click();
    // On a phone, a bottom sheet with the action first (D250).
    const buttons =
      layout === 'mobile'
        ? ['Discard the changes', 'Keep editing']
        : ['Keep editing', 'Discard the changes'];
    await expect(page.getByRole('dialog')).toMatchAriaSnapshot(`
      - dialog "Discard the changes":
        - note: The changes made to this item are not saved and will be lost.
        - button "${buttons[0] ?? ''}"
        - button "${buttons[1] ?? ''}"
    `);
    await button(page, 'Discard the changes').click();

    // A wrong password is an alert beside the invalid field.
    await lock(page);
    await page.getByTestId('unlock-password').fill('wrong-password-0000');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Wrong password.')).toBeVisible({ timeout: 30_000 });
    await expect(main).toMatchAriaSnapshot(`
      - text: BlindVault
      - button "Preview"
      - text: Locked
      - heading "Unlock the vault" [level=1]
      - textbox "Local password" [invalid]
      - alert: Wrong password.
      - button "Forgot the password?"
    `);
  });
}
