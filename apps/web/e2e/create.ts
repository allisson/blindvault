// Vault creation as a user goes through it (§13.3, D179): the Recovery Phrase, its confirmation,
// then the local password.

import { type Locator, type Page, expect } from '@playwright/test';

/**
 * Waits for the three starts. Playwright's WebKit is Safari in a plain tab, where the first screen
 * advises installing the app first (D103, D198): this continues in the tab.
 */
export async function startScreen(page: Page): Promise<void> {
  const starts = page.getByRole('button', { name: 'Create a new vault', exact: true });
  const advice = page.getByRole('button', { name: 'Continue in this tab', exact: true });
  await expect(starts.or(advice)).toBeVisible();
  if (await advice.isVisible()) await advice.click();
  await expect(starts).toBeVisible();
}

/** Chooses to create a vault on the first screen, unless the phrase screen is already shown. */
export async function chooseCreate(page: Page): Promise<void> {
  const phrase = page.getByTestId('recovery-phrase');
  const advice = page.getByRole('button', { name: 'Continue in this tab', exact: true });
  const choice = page.getByRole('button', { name: 'Create a new vault', exact: true });
  await expect(choice.or(phrase).or(advice)).toBeVisible();
  if (await phrase.isVisible()) return;
  await startScreen(page);
  await choice.click();
}

/** The 24 words on the phrase screen, in order. */
export async function readPhrase(page: Page): Promise<string[]> {
  await chooseCreate(page);
  await expect(page.getByTestId('recovery-phrase')).toBeVisible();
  const words: string[] = [];
  for (let n = 1; n <= 24; n++) {
    words.push((await page.getByTestId(`phrase-word-${String(n)}`).textContent()) ?? '');
  }
  return words;
}

/** Types the words the confirmation asks for, from `words`, or from `answer` when given. */
export async function answerConfirmation(
  page: Page,
  words: readonly string[],
  answer: (word: string) => string = (w) => w,
): Promise<number[]> {
  const fields = page.locator('[data-testid^="confirm-word-"]');
  await expect(fields).toHaveCount(3);
  const positions: number[] = [];
  for (const field of await fields.all()) {
    const n = Number((await field.getAttribute('data-testid'))?.replace('confirm-word-', ''));
    positions.push(n);
    await field.fill(answer(words[n - 1] ?? ''));
  }
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  return positions;
}

/** Reads the phrase, confirms it and stops at the password step; returns the words. */
export async function confirmPhrase(page: Page): Promise<string[]> {
  const words = await readPhrase(page);
  await page.getByRole('button', { name: 'I wrote them down', exact: true }).click();
  await answerConfirmation(page, words);
  await expect(page.getByTestId('new-password')).toBeVisible();
  return words;
}

/** Closes "Vault ready", shown once after a creation or a restore (D198). */
export async function openVault(page: Page): Promise<void> {
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Open the vault', exact: true }).click();
  await expect(page.getByTestId('ready')).toHaveCount(0);
}

/**
 * Creates the vault with `password` and waits for it to be unlocked, past "Vault ready"; returns
 * the phrase.
 */
export async function createVault(page: Page, password: string): Promise<string[]> {
  const words = await confirmPhrase(page);
  await page.getByTestId('new-password').fill(password);
  await page.getByTestId('confirm-password').fill(password);
  await page.getByRole('button', { name: 'Create vault', exact: true }).click();
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });
  await openVault(page);
  return words;
}

/** A page of Settings (D252): the index lists them as rows with a `settings-<page>` test id. */
export type SettingsPageName =
  | 'appearance'
  | 'language'
  | 'locking'
  | 'password'
  | 'passkey'
  | 'recovery'
  | 'devices'
  | 'backup'
  | 'merge'
  | 'import'
  | 'storage'
  | 'refound'
  | 'erase'
  | 'about';

/**
 * Opens a main destination of the sidebar (D316): on a tablet, from Menu's drawer; on a phone, its
 * tab in the bottom bar.
 */
async function openMain(page: Page, name: 'Devices' | 'Settings'): Promise<void> {
  const entry = page.getByRole('button', { name, exact: true }).first();
  const menu = page.getByRole('button', { name: 'Menu', exact: true });
  // Menu shows on a tablet only, and by the layout, not by a button still on its way out after a
  // resize.
  const tablet = (await page.locator('[data-layout]').getAttribute('data-layout')) === 'tablet';
  if (tablet && !(await entry.isVisible())) await menu.click();
  await entry.click();
}

/** Opens the Settings index, a main destination (D316). */
export async function openSettings(page: Page): Promise<void> {
  await openMain(page, 'Settings');
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
}

/**
 * Back to a list from a detail, a page of Settings, Devices or Notices: Back where there is one,
 * then the phone's Items tab for the Settings index and Devices, which have none (D316).
 */
export async function toList(page: Page): Promise<void> {
  const back = page.getByRole('button', { name: 'Back', exact: true });
  while (await back.isVisible()) await back.click();
  const items = page.getByRole('contentinfo').getByRole('button', { name: 'Items', exact: true });
  if ((await items.isVisible()) && (await items.getAttribute('aria-current')) === null) {
    await items.click();
  }
}

/** Opens Devices, a main destination of its own (D316). */
export async function openDevices(page: Page): Promise<void> {
  await openMain(page, 'Devices');
  await expect(page.getByTestId('devices')).toBeVisible();
}

/** Opens Settings from the vault, then one of its pages; `devices` opens Devices (D316). */
export async function openSettingsPage(page: Page, name: SettingsPageName): Promise<void> {
  if (name === 'devices') {
    await openDevices(page);
    return;
  }
  await openMain(page, 'Settings');
  await page.getByTestId(`settings-${name}`).click();
}

/**
 * From a page of Settings, back to the index and on to another page; `devices` opens Devices. From
 * Devices, which is no page of Settings (D316), the page opens from Settings.
 */
export async function switchSettingsPage(page: Page, name: SettingsPageName): Promise<void> {
  if (name === 'devices') {
    await openDevices(page);
    return;
  }
  if (await page.getByTestId('devices').isVisible()) {
    await openSettingsPage(page, name);
    return;
  }
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByTestId(`settings-${name}`).click();
}

/**
 * Opens the Notices screen from the status card, the tablet's pill or the phone's line (D316). A
 * tablet's closed drawer holds a hidden copy of the card: only the visible one counts.
 */
export async function openNotices(page: Page): Promise<void> {
  await page
    .getByTestId('notices-open')
    .or(page.getByTestId('status-pill'))
    .locator('visible=true')
    .first()
    .click();
  await expect(page.getByTestId('notices')).toBeVisible();
}

/** Opens the advanced options of a device wizard's first step, unless open already (D253). */
export async function openAdvanced(scope: Page | Locator): Promise<void> {
  const box = scope.getByTestId('pairing-same-network');
  if (!(await box.isVisible()))
    await scope.getByTestId('advanced-options').locator('summary').click();
  await expect(box).toBeVisible();
}

/** Checks "Same network only" in the advanced options (D203, D253). */
export async function checkSameNetwork(scope: Page | Locator): Promise<void> {
  await openAdvanced(scope);
  await scope.getByTestId('pairing-same-network').check();
}
