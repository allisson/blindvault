// Vault creation as a user goes through it (§13.3, D179): the Recovery Phrase, its confirmation,
// then the local password.

import { type Page, expect } from '@playwright/test';

/** Chooses to create a vault on the first screen, unless the phrase screen is already shown. */
export async function chooseCreate(page: Page): Promise<void> {
  const choice = page.getByRole('button', { name: 'Create a new vault', exact: true });
  const phrase = page.getByTestId('recovery-phrase');
  await expect(choice.or(phrase)).toBeVisible();
  if (await choice.isVisible()) await choice.click();
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

/** Creates the vault with `password` and waits for it to be unlocked; returns the phrase. */
export async function createVault(page: Page, password: string): Promise<string[]> {
  const words = await confirmPhrase(page);
  await page.getByTestId('new-password').fill(password);
  await page.getByTestId('confirm-password').fill(password);
  await page.getByRole('button', { name: 'Create vault', exact: true }).click();
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });
  return words;
}
