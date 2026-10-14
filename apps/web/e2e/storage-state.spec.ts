// The storage state (overview §7, §13.2, D55, D119, D196). The browser's answers are replaced before
// the app loads, since a test cannot make a real browser refuse persistence or fill its quota.

import { type Page, expect, test } from '@playwright/test';

import { createVault } from './create';

// Creating a vault calibrates Argon2id at about 1 s (D9).
test.setTimeout(120_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';
const SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15';
const WIDTHS = [390, 800, 1280] as const;
/** Playwright's WebKit names itself Safari, and is: the other tests take another browser's name. */
const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

test.use({ userAgent: CHROME });

interface FakeStorage {
  persisted: boolean;
  /** What the next `persist()` answers; a grant also makes `persisted()` true. */
  grant: boolean;
  usage: number;
  quota: number;
}

/** Replaces `navigator.storage`'s answers, which the test can change later on `window.__storage`. */
async function fakeStorage(page: Page, fake: FakeStorage): Promise<void> {
  await page.addInitScript((initial) => {
    const w = window as unknown as { __storage: FakeStorage };
    w.__storage = initial;
    const define = (name: string, value: () => Promise<unknown>) => {
      Object.defineProperty(navigator.storage, name, { configurable: true, value });
    };
    define('persisted', () => Promise.resolve(w.__storage.persisted));
    define('persist', () => {
      if (w.__storage.grant) w.__storage.persisted = true;
      return Promise.resolve(w.__storage.grant);
    });
    define('estimate', () =>
      Promise.resolve({ usage: w.__storage.usage, quota: w.__storage.quota }),
    );
  }, fake);
}

async function setStorage(page: Page, change: Partial<FakeStorage>): Promise<void> {
  await page.evaluate((c) => {
    const w = window as unknown as { __storage: FakeStorage };
    Object.assign(w.__storage, c);
  }, change);
}

/** The app returns to visible: it reads the storage status again (D196). */
async function returnToVisible(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

async function openSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await expect(page.getByTestId('device-storage')).toBeVisible();
}

const KEPT: FakeStorage = { persisted: true, grant: true, usage: 50_000, quota: 1_000_000 };

test('shows the storage state in Settings and no warning while storage is kept with room (D196)', async ({
  page,
}) => {
  await fakeStorage(page, KEPT);
  await page.goto('/');
  await expect(page.getByTestId('storage-warning')).toHaveCount(0);
  await createVault(page, PASSWORD);
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    await expect(page.getByTestId('lock-state')).toHaveText('Unlocked');
    await expect(page.getByTestId('storage-warning')).toHaveCount(0);
  }
  await openSettings(page);
  const section = page.getByTestId('device-storage');
  await expect(section.getByTestId('storage-persistence')).toHaveText(
    'The browser keeps this vault’s storage, even when space runs low.',
  );
  await expect(section.getByTestId('storage-usage')).toHaveText(
    'Storage used by BlindVault on this device: 50 kB of 1 MB available (5%).',
  );
  await expect(section.getByTestId('device-last-backup')).toHaveText(
    'No backup has been made on this device yet.',
  );
  await expect(
    section.getByRole('button', { name: 'Ask the browser to keep the storage' }),
  ).toHaveCount(0);
  await expect(section.getByTestId('storage-warnings')).toHaveCount(0);
});

test('warns while storage is not kept on the only device, in every layout, until the browser keeps it (D119, D196)', async ({
  page,
}) => {
  await fakeStorage(page, { ...KEPT, persisted: false, grant: false });
  await page.goto('/');
  // Before unlock the device count is unknown: no warning but Safari's.
  await expect(page.getByTestId('storage-warning')).toHaveCount(0);
  await createVault(page, PASSWORD);
  const banner = page.getByTestId('storage-warning');
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    await expect(banner).toHaveAttribute('data-warning', 'not-kept');
    await expect(banner).toContainText('this is the only device of the vault');
    // Nothing dismisses it.
    await expect(banner.getByRole('button')).toHaveCount(0);
  }

  await openSettings(page);
  const section = page.getByTestId('device-storage');
  await expect(section.getByTestId('storage-persistence')).toContainText(
    'The browser may delete this vault’s storage when space runs low.',
  );
  const ask = section.getByRole('button', { name: 'Ask the browser to keep the storage' });
  // Refused: the section says so, and the warning stays.
  await ask.click();
  await expect(section.getByText('The browser did not agree to keep the storage.')).toBeVisible();
  await expect(banner).toHaveAttribute('data-warning', 'not-kept');
  // Granted: the status reads kept, and the warning and the button go.
  await setStorage(page, { grant: true });
  await ask.click();
  await expect(section.getByTestId('storage-persistence')).toHaveText(
    'The browser keeps this vault’s storage, even when space runs low.',
  );
  await expect(banner).toHaveCount(0);
  await expect(ask).toHaveCount(0);
});

test('warns while storage is nearly full, and reads it again on return to visible (D196)', async ({
  page,
}) => {
  await fakeStorage(page, { ...KEPT, usage: 800_000 });
  await page.goto('/');
  await createVault(page, PASSWORD);
  const banner = page.getByTestId('storage-warning');
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    await expect(banner).toHaveAttribute('data-warning', 'nearly-full');
    await expect(banner).toContainText('BlindVault uses 80% of what the browser allows');
  }
  // A byte under 80% is not nearly full; nothing changes until the app reads it again.
  await setStorage(page, { usage: 799_999 });
  await expect(banner).toBeVisible();
  await returnToVisible(page);
  await expect(banner).toHaveCount(0);
});

test.describe('Safari', () => {
  test.use({ userAgent: SAFARI });

  test('in a plain tab, warns before unlock and first of all after it, in every layout (D55, D103, D196)', async ({
    page,
  }) => {
    await fakeStorage(page, { ...KEPT, persisted: false, grant: false, usage: 900_000 });
    await page.goto('/');
    const banner = page.getByTestId('storage-warning');
    await expect(banner).toHaveAttribute('data-warning', 'safari-tab');
    await expect(banner).toContainText('installing does not take this vault along');
    await createVault(page, PASSWORD);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      await expect(banner).toHaveAttribute('data-warning', 'safari-tab');
    }
    // Settings lists all three, in order.
    await openSettings(page);
    const listed = page.getByTestId('storage-warnings').getByRole('note');
    await expect(listed).toHaveCount(3);
    await expect(listed.nth(0)).toContainText('Install the app');
    await expect(listed.nth(1)).toContainText('this is the only device of the vault');
    await expect(listed.nth(2)).toContainText('BlindVault uses 90% of what the browser allows');
  });

  test('installed, does not warn (D55, D196)', async ({ page }) => {
    await fakeStorage(page, KEPT);
    await page.addInitScript(() => {
      const original = window.matchMedia.bind(window);
      window.matchMedia = (query: string) =>
        query === '(display-mode: standalone)'
          ? ({
              matches: true,
              media: query,
              onchange: null,
              addEventListener: () => undefined,
              removeEventListener: () => undefined,
              addListener: () => undefined,
              removeListener: () => undefined,
              dispatchEvent: () => false,
            } as MediaQueryList)
          : original(query);
    });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Create a new vault' })).toBeVisible();
    await expect(page.getByTestId('storage-warning')).toHaveCount(0);
    await createVault(page, PASSWORD);
    await expect(page.getByTestId('lock-state')).toHaveText('Unlocked');
    await expect(page.getByTestId('storage-warning')).toHaveCount(0);
  });
});
