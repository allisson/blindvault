import { type Page, expect, test } from '@playwright/test';

import { answerConfirmation, createVault, readPhrase } from './create';

// Calibrating Argon2id targets about 1 s per derivation (D9), on every browser.
test.setTimeout(120_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';

function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

/** Every value in every IndexedDB database and in Web Storage, as UTF-8 text where it decodes. */
async function stored(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const out: string[] = [];
    for (const storage of [localStorage, sessionStorage]) {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i) ?? '';
        out.push(key, storage.getItem(key) ?? '');
      }
    }
    const decoder = new TextDecoder('utf-8', { fatal: false });
    for (const { name } of await indexedDB.databases()) {
      if (!name) continue;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => {
          resolve(request.result);
        };
        request.onerror = () => {
          reject(new Error('open failed'));
        };
      });
      const names = [...db.objectStoreNames];
      if (names.length > 0) {
        const tx = db.transaction(names);
        const requests = names.map((s) => tx.objectStore(s).getAll());
        await new Promise((resolve) => (tx.oncomplete = resolve));
        for (const r of requests) {
          for (const v of r.result as unknown[]) {
            out.push(v instanceof Uint8Array ? decoder.decode(v) : JSON.stringify(v));
          }
        }
      }
      db.close();
    }
    return out;
  });
}

test('shows the phrase once, asks for three of its words, and shows it again on a wrong answer (D179)', async ({
  page,
}) => {
  await page.goto('/');
  const words = await readPhrase(page);
  expect(words).toHaveLength(24);
  expect(words.every((w) => /^[a-z]+$/.test(w))).toBe(true);
  await expect(page.getByText(/Do not take a screenshot or a photo/)).toBeVisible();
  // No copy or download control on the phrase screen.
  await expect(page.getByRole('button')).toHaveText(['I wrote them down']);
  await expect(page.getByRole('link')).toHaveCount(0);

  await button(page, 'I wrote them down').click();
  const asked = await answerConfirmation(page, words, (w) => `${w}x`);
  expect(asked).toHaveLength(3);
  await expect(page.getByText(/Those words do not match/)).toBeVisible();
  // The same phrase, not a new one.
  expect(await readPhrase(page)).toEqual(words);

  await button(page, 'I wrote them down').click();
  await answerConfirmation(page, words, (w) => ` ${w.toUpperCase()} `);
  await expect(page.getByTestId('new-password')).toBeVisible();
  await expect(page.getByTestId('recovery-phrase')).toHaveCount(0);
});

/**
 * What a stored phrase would contain: the whole phrase and every pair of neighbouring words, with
 * or without a space. Single words are not enough: BIP39 words such as "language" or "local" also
 * appear in the app's own keys.
 */
function traces(words: readonly string[]): string[] {
  const out = [words.join(' ')];
  for (let i = 0; i + 1 < words.length; i++) {
    out.push(`${words[i] ?? ''} ${words[i + 1] ?? ''}`, `${words[i] ?? ''}${words[i + 1] ?? ''}`);
  }
  return out;
}

test('keeps the phrase out of IndexedDB and Web Storage, before and after creation (CRYPTO-INV-006)', async ({
  page,
}) => {
  await page.goto('/');
  const shown = await readPhrase(page);
  const found = (values: readonly string[], words: readonly string[]) =>
    traces(words).filter((t) => values.some((v) => v.includes(t)));
  expect(found(await stored(page), shown)).toEqual([]);
  // A reload shows another phrase: the first one was never stored.
  await page.reload();
  const words = await createVault(page, PASSWORD);
  expect(words).not.toEqual(shown);
  const values = await stored(page);
  expect(values.length).toBeGreaterThan(0);
  expect(found(values, words)).toEqual([]);
  expect(found(values, shown)).toEqual([]);
});
