// Vault creation as a user goes through it (§13.3, D179): the Recovery Phrase, its confirmation,
// then the local password.

import { type Page, expect } from '@playwright/test';

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
