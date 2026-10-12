import { type Page, expect, test } from '@playwright/test';

import { createVault } from './create';

// Calibrating Argon2id targets about 1 s per derivation (D9), on every browser.
test.setTimeout(120_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';
const TITLE = 'Harbor Credit Union';
const USERNAME = 'ana.lima.7731';
const SECRET = 'Tulip-Orbit-5528-Granite';

const WIDTHS = [
  ['mobile', 375],
  ['tablet', 800],
  ['desktop', 1280],
] as const;

type Layout = (typeof WIDTHS)[number][0];

async function create(page: Page) {
  await page.goto('/');
  await createVault(page, PASSWORD);
}

async function newLogin(page: Page) {
  await page.getByRole('button', { name: 'New item', exact: true }).click();
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await page.getByTestId('item-title').fill(TITLE);
  await page.getByTestId('input-Username').fill(USERNAME);
  await page.getByTestId('input-Password').fill(SECRET);
  await page.getByTestId('input-Website').fill('https://harbor.example');
  await page.getByTestId('item-tags').fill('bank, Bank, family');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('heading', { name: TITLE })).toBeVisible();
}

/** Opens a list from the folder pane: in the drawer on tablet, on the list screen on mobile. */
async function showList(page: Page, layout: Layout, name: 'All items' | 'Trash') {
  if (
    layout === 'mobile' &&
    (await page.getByRole('button', { name: 'Back', exact: true }).isVisible())
  ) {
    await page.getByRole('button', { name: 'Back', exact: true }).click();
  }
  if (layout === 'tablet' && !(await page.getByRole('button', { name, exact: true }).isVisible())) {
    await page.getByRole('button', { name: 'Folders', exact: true }).click();
  }
  await page.getByRole('button', { name, exact: true }).click();
}

for (const [layout, width] of WIDTHS) {
  test(`creates, reads, edits, trashes and restores an item on ${layout}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await create(page);
    await expect(page.locator('[data-layout]')).toHaveAttribute('data-layout', layout);
    const before = await page.evaluate(() => window.history.length);

    await newLogin(page);
    // Masked by default; revealing takes an explicit action (overview §13.2).
    const secret = page.getByTestId('secret-Password');
    await expect(secret).toHaveText('••••••••');
    await expect(page.getByText(SECRET)).toHaveCount(0);
    await page.getByRole('button', { name: 'Show', exact: true }).click();
    await expect(secret).toHaveText(SECRET);
    await expect(page.getByText('bank', { exact: true })).toBeVisible();
    await expect(page.getByText('family', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    // The editor masks the secret again.
    await expect(page.getByTestId('input-Password')).toHaveAttribute('type', 'password');
    await page.getByTestId('input-Username').fill('ana.lima.0042');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('ana.lima.0042')).toBeVisible();
    await expect(page.getByTestId('secret-Password')).toHaveText('••••••••');

    await page.getByRole('button', { name: 'Move to trash', exact: true }).click();
    await expect(page.getByRole('heading', { name: TITLE })).toHaveCount(0);
    await expect(page.getByText('No items yet.')).toBeVisible();

    await showList(page, layout, 'Trash');
    await page.getByRole('button', { name: TITLE, exact: true }).click();
    // An item in the trash allows only restore (D143).
    await expect(page.getByText(/It can only be restored/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect(page.getByText('The trash is empty.')).toBeVisible();

    await showList(page, layout, 'All items');
    await page.getByRole('button', { name: TITLE, exact: true }).click();
    await expect(page.getByText('ana.lima.0042')).toBeVisible();

    await page.getByRole('button', { name: 'Lock', exact: true }).click();
    await page.getByTestId('unlock-password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 30_000 });
    // Navigation starts again at the vault root after a lock.
    await expect(page.getByRole('heading', { name: TITLE })).toHaveCount(0);
    await expect(page.getByRole('button', { name: TITLE, exact: true })).toBeVisible();

    // D167: no vault identifier or screen in the URL or the history.
    expect(new URL(page.url()).pathname).toBe('/');
    expect(new URL(page.url()).search + new URL(page.url()).hash).toBe('');
    expect(await page.evaluate(() => window.history.length)).toBe(before);
  });
}

test('refuses an invalid item with a message per field (record-content.md §3, §4)', async ({
  page,
}) => {
  await create(page);
  await page.getByRole('button', { name: 'New item', exact: true }).click();
  await page.getByRole('button', { name: 'Payment card', exact: true }).click();
  await page.getByTestId('input-Expiry').fill('2027-13');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Enter a title.')).toBeVisible();
  await expect(page.getByText('Enter a month as YYYY-MM.')).toBeVisible();
  await page.getByTestId('item-title').fill('Visa');
  await page.getByTestId('input-Expiry').fill('2027-05');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByTestId('input-Text').fill('note');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Enter a label for this field.')).toBeVisible();
  await page.getByTestId('custom-label').fill('Branch');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Visa' })).toBeVisible();
  await expect(page.getByText('2027-05')).toBeVisible();
  await expect(page.getByText('Branch')).toBeVisible();
});

test('fills a secret from the password generator (D128)', async ({ page }) => {
  await create(page);
  await page.getByRole('button', { name: 'New item', exact: true }).click();
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  // 20 characters from 94: 131 bits.
  await expect(page.getByTestId('generator-entropy')).toHaveText('131 bits of entropy');
  await page.getByRole('button', { name: 'Use this password', exact: true }).click();
  await expect(page.getByTestId('input-Password')).toHaveValue(/^.{20}$/);
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await page.getByLabel('Words', { exact: true }).check();
  await expect(page.getByTestId('generator-entropy')).toHaveText('66 bits of entropy');
  await page.getByLabel('Words (4–24)').fill('3');
  await expect(page.getByRole('button', { name: 'Use this password', exact: true })).toBeDisabled();
});

test('IndexedDB and localStorage hold no item plaintext (CRYPTO-INV-001)', async ({ page }) => {
  await create(page);
  await newLogin(page);
  const found = await page.evaluate(
    async (needles) => {
      const chunks: Uint8Array[] = [];
      const collect = (value: unknown): void => {
        if (value instanceof Uint8Array) chunks.push(value);
        else if (value instanceof ArrayBuffer) chunks.push(new Uint8Array(value));
        else if (typeof value === 'string') chunks.push(new TextEncoder().encode(value));
        else if (Array.isArray(value)) value.forEach(collect);
        else if (value && typeof value === 'object') Object.values(value).forEach(collect);
      };
      for (const { name } of await indexedDB.databases()) {
        if (!name) continue;
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(name);
          request.onsuccess = () => {
            resolve(request.result);
          };
          request.onerror = () => {
            reject(new Error(String(request.error)));
          };
        });
        for (const store of Array.from(db.objectStoreNames)) {
          const values = await new Promise<unknown[]>((resolve, reject) => {
            const request = db.transaction(store).objectStore(store).getAll();
            request.onsuccess = () => {
              resolve(request.result);
            };
            request.onerror = () => {
              reject(new Error(String(request.error)));
            };
          });
          collect(values);
        }
        db.close();
      }
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i) ?? '';
        collect(key);
        collect(localStorage.getItem(key));
      }
      const contains = (hay: Uint8Array, needle: Uint8Array) => {
        outer: for (let i = 0; i + needle.length <= hay.length; i++) {
          for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
          return true;
        }
        return false;
      };
      return {
        chunks: chunks.length,
        found: needles.filter((n) => {
          const bytes = new TextEncoder().encode(n);
          return chunks.some((c) => contains(c, bytes));
        }),
      };
    },
    [TITLE, USERNAME, SECRET, 'harbor.example', 'family'],
  );
  expect(found.chunks).toBeGreaterThan(0);
  expect(found.found).toEqual([]);
});
