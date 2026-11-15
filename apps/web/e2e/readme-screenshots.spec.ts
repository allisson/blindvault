// The README's screenshots, light and dark: `pnpm --filter @blindvault/web screenshots` writes them
// to docs/screenshots/. Not part of the test run (playwright.config.ts): it checks nothing, it only
// walks the screens with made-up data. Run it again when a screen it shows changes.

import { fileURLToPath } from 'node:url';

import { type Browser, type Page, expect, test } from '@playwright/test';

import { checkSameNetwork, createVault, openSettingsPage, startScreen } from './create';
import { fillPassword } from './password';
import { PAIRING_URL } from '../playwright.config';

// Two vault creations and a pairing, each with Argon2id at about 1 s (D9).
test.setTimeout(300_000);

// Firefox gathers no ICE candidate on `localhost`, and the pairing runs here too.
test.use({ baseURL: PAIRING_URL });

const OUT = fileURLToPath(new URL('../../../docs/screenshots/', import.meta.url));
const PASSWORD_A = 'quartz-lantern-velvet-harbor-9214';
const PASSWORD_B = 'meadow-copper-signal-anchor-3071';
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 390, height: 844 };
// The pairing wizard is one centered card: a smaller window keeps the shot on it.
const CARD = { width: 640, height: 720 };
// The RFC 6238 test key in base32: a made-up account.
const TOTP = 'otpauth://totp/GitHub:ana.lima?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=GitHub';

function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

/** Both themes of what `page` shows now, as `<name>-light.png` and `<name>-dark.png`. */
async function shoot(page: Page, name: string) {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${OUT}${name}-${theme}.png`, animations: 'disabled' });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

async function device(browser: Browser, viewport = DESKTOP): Promise<Page> {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto('/');
  return page;
}

async function folder(page: Page, name: string) {
  await button(page, '+ New folder').click();
  await page.getByTestId('folder-name').fill(name);
  await button(page, 'Create').click();
  await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible();
}

interface Item {
  readonly template: string;
  readonly title: string;
  readonly folder: string;
  readonly fields?: Readonly<Record<string, string>>;
  readonly totp?: string;
  readonly tags?: string;
}

const ITEMS: readonly Item[] = [
  {
    template: 'Login',
    title: 'Harbor Credit Union',
    folder: 'Finance',
    fields: {
      Username: 'ana.lima.7731',
      Password: 'Tulip-Orbit-5528-Granite',
      Website: 'https://harbor.example',
    },
    tags: 'bank',
  },
  {
    template: 'Payment card',
    title: 'Travel card',
    folder: 'Finance',
    fields: { Cardholder: 'Ana Lima' },
  },
  {
    template: 'Developer credential',
    title: 'Cloud API key',
    folder: 'Work',
    fields: { Provider: 'Example Cloud', 'Key ID': 'AKEX4R7Q2M' },
  },
  { template: 'Secure note', title: 'Office Wi-Fi', folder: 'Work' },
  {
    template: 'Document',
    title: 'Passport',
    folder: 'Personal',
    fields: { 'Full name': 'Ana Lima' },
  },
  { template: 'Secure note', title: 'Home alarm code', folder: 'Personal' },
  {
    template: 'Login',
    title: 'GitHub',
    folder: 'Work',
    fields: {
      Username: 'ana.lima',
      Password: 'Velvet-Comet-8841-Basalt',
      Website: 'https://github.com/login',
    },
    totp: TOTP,
    tags: 'dev, 2fa',
  },
];

async function item(page: Page, i: Item) {
  await button(page, 'New item').click();
  await button(page, i.template).click();
  await page.getByTestId('item-title').fill(i.title);
  await page.getByTestId('item-folder').selectOption({ label: i.folder });
  for (const [label, value] of Object.entries(i.fields ?? {}))
    await page.getByTestId(`input-${label}`).fill(value);
  if (i.totp) {
    await page.getByTestId('add-field-type').selectOption('totp');
    await button(page, 'Add').click();
    await page.getByTestId('custom-label').fill('2FA');
    await page.getByTestId('input-2FA').fill(i.totp);
  }
  if (i.tags) await page.getByTestId('item-tags').fill(i.tags);
  await button(page, 'Save').click();
  await expect(page.getByRole('heading', { name: i.title, level: 1 })).toBeVisible();
}

/**
 * Pairs a second device with `a`, through the numbers both compare (§8.4), shot on the joining
 * device, which has no vault yet and so no storage warning.
 */
async function pair(browser: Browser, a: Page) {
  await openSettingsPage(a, 'devices');
  await button(a, 'Pair a device…').click();
  await checkSameNetwork(a);
  await fillPassword(a.getByTestId('invite-password'), PASSWORD_A);
  await button(a, 'Start pairing').click();
  const offer = a.getByTestId('pairing-text');
  await expect(offer).not.toHaveValue('', { timeout: 30_000 });

  const b = await device(browser, CARD);
  await startScreen(b);
  await button(b, 'Pair with an existing device').click();
  await fillPassword(b.getByTestId('new-password'), PASSWORD_B);
  await fillPassword(b.getByTestId('confirm-password'), PASSWORD_B);
  await checkSameNetwork(b);
  await button(b, 'Start pairing').click();
  await b.getByTestId('pairing-paste').fill(await offer.inputValue(), { timeout: 30_000 });
  await button(b, 'Show my answer').click();
  const answer = b.getByTestId('pairing-text');
  await expect(answer).not.toHaveValue('', { timeout: 30_000 });
  await a.getByTestId('pairing-paste').fill(await answer.inputValue());
  await button(a, 'Connect').click();
  await expect(a.getByTestId('pairing-sas')).toHaveText(/^\d{3} \d{3}$/, { timeout: 30_000 });
  await expect(b.getByTestId('pairing-sas')).toHaveText(/^\d{3} \d{3}$/, { timeout: 30_000 });
  await shoot(b, 'pairing');

  await button(a, 'Yes, the same').click();
  await button(b, 'Yes, the same').click();
  await expect(b.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 60_000 });
  await expect(a.getByTestId('pairing-done')).toContainText('is paired', { timeout: 60_000 });
  await button(a, 'Close').click();
  await b.context().close();
  await button(a, 'Back').click();
  await button(a, 'Back').click();
}

test('README screenshots', async ({ browser }) => {
  const a = await device(browser);
  await createVault(a, PASSWORD_A);
  for (const name of ['Finance', 'Personal', 'Work']) await folder(a, name);
  for (const i of ITEMS) await item(a, i);
  // A second device: the storage warning for the only device goes away (D196).
  await pair(browser, a);
  await a.getByTestId('backup-reminder').getByRole('button').first().click();

  await button(a, 'Work').click();
  await a
    .getByRole('button', { name: /GitHub/ })
    .first()
    .click();
  await expect(a.getByTestId('totp-2FA')).toHaveText(/^\d{3} \d{3}$/);
  await expect(a.getByTestId('toast')).toHaveCount(0);
  await shoot(a, 'vault-desktop');

  // The generator in a new Login's editor.
  await button(a, 'New item').click();
  await button(a, 'Login').click();
  await a.getByTestId('item-title').fill('Example Shop');
  await button(a, 'Generate').click();
  await expect(a.getByTestId('generator-entropy')).toHaveText('131 bits of entropy');
  await shoot(a, 'generator');
  await a
    .getByRole('dialog', { name: 'Password generator' })
    .getByRole('button', { name: 'Cancel' })
    .click();
  await button(a, 'Cancel').click();
  await button(a, 'Discard the changes').click();

  // The mobile layout: the list of a folder, then an item.
  await a.setViewportSize(MOBILE);
  await shoot(a, 'list-mobile');
  await a
    .getByRole('button', { name: /GitHub/ })
    .first()
    .click();
  await expect(a.getByTestId('totp-2FA')).toHaveText(/^\d{3} \d{3}$/);
  await shoot(a, 'item-mobile');
});
