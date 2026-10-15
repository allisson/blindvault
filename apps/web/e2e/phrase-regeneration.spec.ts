import { readFile } from 'node:fs/promises';

import { type Page, expect, test } from '@playwright/test';

import { answerConfirmation, createVault } from './create';

// Calibrating Argon2id targets about 1 s per derivation (D9); exports and the regeneration derive
// again.
test.setTimeout(180_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';
const WRONG = 'quartz-lantern-velvet-harbor-9215';

function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

/** The 8 hex digits naming the current phrase in Settings (D185). */
async function currentId(page: Page): Promise<string> {
  const text = (await page.getByTestId('recovery-current').textContent()) ?? '';
  return /\(([0-9a-f]{8})\)/.exec(text)?.[1] ?? '';
}

async function exportBackup(page: Page): Promise<Buffer> {
  await page.getByTestId('backup-password').fill(PASSWORD);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    button(page, 'Export').click(),
  ]);
  return readFile(await download.path());
}

/** Starts a regeneration and returns the new phrase's 24 words, as shown. */
async function newPhrase(page: Page): Promise<string[]> {
  await page.getByTestId('regenerate-start').click();
  await expect(page.getByTestId('regenerate-exposed')).toContainText('re-founded');
  await button(page, 'Show the new phrase').click();
  await expect(page.getByTestId('recovery-phrase')).toBeVisible();
  const words: string[] = [];
  for (let n = 1; n <= 24; n++) {
    words.push((await page.getByTestId(`phrase-word-${String(n)}`).textContent()) ?? '');
  }
  return words;
}

async function check(page: Page, words: readonly string[]) {
  await page.getByTestId('check-phrase').fill(words.join(' '));
  await button(page, 'Check Recovery Phrase').click();
}

test('regenerates the Recovery Phrase, keeping the vault, and asks for a new backup (D2, D185)', async ({
  page,
}) => {
  const logged: string[] = [];
  page.on('console', (message) => logged.push(message.text()));
  await page.goto('/');
  const old = await createVault(page, PASSWORD);
  await button(page, 'New item').click();
  await button(page, 'Login').click();
  await page.getByTestId('item-title').fill('ACME');
  await button(page, 'Save').click();
  await expect(page.getByRole('heading', { name: 'ACME', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Settings' }).first().click();
  const oldId = await currentId(page);
  expect(oldId).toMatch(/^[0-9a-f]{8}$/);
  await exportBackup(page);
  await expect(page.getByTestId('recovery-no-backup')).toHaveCount(0);

  const words = await newPhrase(page);
  expect(words).not.toEqual(old);
  await button(page, 'I wrote them down').click();
  await answerConfirmation(page, words);
  await expect(page.getByTestId('recovery-phrase')).toHaveCount(0);

  // Another local password changes nothing; the phrase stays for another try.
  await page.getByTestId('regenerate-password').fill(WRONG);
  await button(page, 'Regenerate').click();
  await expect(page.getByText('Wrong password. The Recovery Phrase did not change.')).toBeVisible({
    timeout: 30_000,
  });
  await page.getByTestId('regenerate-password').fill(PASSWORD);
  await button(page, 'Regenerate').click();
  const done = page.getByTestId('regenerate-done');
  await expect(done).toBeVisible({ timeout: 30_000 });
  const newId = await currentId(page);
  expect(newId).toMatch(/^[0-9a-f]{8}$/);
  expect(newId).not.toBe(oldId);
  await expect(done).toContainText(`The Recovery Phrase was regenerated: ${newId}`);
  await expect(done).toContainText('not on your other devices yet');
  // The backup made before opens only with the previous phrase.
  await expect(page.getByTestId('recovery-no-backup')).toBeVisible();

  await check(page, words);
  await expect(page.getByText('This phrase opens this vault and its backups.')).toBeVisible();
  await check(page, old);
  await expect(page.getByText("This is not this vault's current Recovery Phrase.")).toBeVisible();

  // "Make a backup now" leads to the export, which names the new phrase.
  await button(page, 'Make a backup now').click();
  await expect(page.getByTestId('backup-password')).toBeFocused();
  await exportBackup(page);
  await expect(page.getByText(`It opens with the Recovery Phrase ${newId}`)).toBeVisible();
  await expect(page.getByTestId('recovery-no-backup')).toHaveCount(0);

  // The vault contents did not change.
  await button(page, 'Back').click();
  await expect(page.getByText('ACME').first()).toBeVisible();
  const traces = [...old, ...words].flatMap((w, i, all) =>
    i + 1 < all.length ? [`${w} ${all[i + 1] ?? ''}`] : [],
  );
  expect(traces.filter((t) => logged.some((l) => l.includes(t)))).toEqual([]);
});

test('pauses the inactivity lock while the new phrase is shown, and resumes it once the phrase is dropped (D104)', async ({
  page,
}) => {
  await page.goto('/');
  await createVault(page, PASSWORD);
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByTestId('autoLockMinutes').fill('1');
  await button(page, 'Save').first().click();
  await expect(page.getByText('Saved.')).toBeVisible();
  const words = await newPhrase(page);
  await page.clock.install();
  // The inactivity timer restarted after the phrase screen opened runs on the fake clock.
  await button(page, 'I wrote them down').click();
  await answerConfirmation(page, words);
  await page.clock.runFor(5 * 60_000);
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked');
  await button(page, 'Cancel').click();
  await page.clock.runFor(61_000);
  await expect(page.getByTestId('lock-state')).toHaveText('Locked');
});
