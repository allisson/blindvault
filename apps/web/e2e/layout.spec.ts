// The layouts (overview §13.1, D15, D197): the panes each width shows, state kept across both
// breakpoints, the tablet drawer, the system's back, the keyboard shortcuts and the touch targets.
// The checks are structural, not pixel screenshots, whose baselines change with each OS and browser.

import { type Page, expect, test } from '@playwright/test';

import { createVault, startScreen } from './create';

// Creating a vault calibrates Argon2id at about 1 s (D9).
test.setTimeout(120_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';
const TITLE = 'Harbor Credit Union';
const SECRET = 'Tulip-Orbit-5528-Granite';
const MASK = '••••••••';
const WIDTHS = [
  ['mobile', 390],
  ['tablet', 800],
  ['desktop', 1280],
] as const;
const LAYOUT = Object.fromEntries(WIDTHS.map(([layout, width]) => [width, layout]));

async function create(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 800 });
  await page.goto('/');
  await createVault(page, PASSWORD);
}

async function resize(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 800 });
  await expect(page.locator('[data-layout]')).toHaveAttribute('data-layout', LAYOUT[width] ?? '');
  // A resize never locks (D15).
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked');
}

/** Saves a login and leaves its view open. */
async function newLogin(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'New item', exact: true }).click();
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await page.getByTestId('item-title').fill(TITLE);
  await page.getByTestId('input-Password').fill(SECRET);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('heading', { name: TITLE })).toBeVisible();
}

async function noOverflow(page: Page, where: string): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `horizontal overflow on ${where}`).toBeLessThanOrEqual(0);
}

const folders = (page: Page) => page.getByRole('navigation', { name: 'Folders' });

for (const [layout, width] of WIDTHS) {
  test(`shows the ${layout} panes, the lock state and masked secrets, without overflow (D15, D197)`, async ({
    page,
  }) => {
    await create(page, width);
    await noOverflow(page, 'the vault');
    await newLogin(page);
    const secret = page.getByTestId('secret-Password');
    await expect(secret).toHaveText(MASK);
    await expect(page.getByText(SECRET)).toHaveCount(0);
    await expect(page.getByTestId('lock-state')).toHaveText('Unlocked');
    await noOverflow(page, 'an item');

    const search = page.getByTestId('search');
    const heading = page.getByRole('heading', { name: TITLE });
    if (layout === 'desktop') {
      await expect(folders(page)).toBeVisible();
      await expect(search).toBeVisible();
      await expect(heading).toBeVisible();
    } else if (layout === 'tablet') {
      // The folder tree waits in its drawer.
      await expect(folders(page)).toBeHidden();
      await expect(page.getByRole('button', { name: 'Folders', exact: true })).toBeVisible();
      await expect(search).toBeVisible();
      await expect(heading).toBeVisible();
    } else {
      // The detail alone, then back to the folders and the list.
      await expect(folders(page)).toBeHidden();
      await expect(search).toBeHidden();
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await expect(heading).toBeHidden();
      await expect(folders(page)).toBeVisible();
      await expect(search).toBeVisible();
      await page.getByRole('button', { name: TITLE, exact: true }).click();
    }

    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.getByTestId('input-Password')).toHaveAttribute('type', 'password');
    await noOverflow(page, 'the editor');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    // Mobile has Settings in its bottom navigation, below the lists.
    if (layout === 'mobile') await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await expect(page.getByTestId('device-storage')).toBeVisible();
    await expect(page.getByTestId('lock-state')).toHaveText('Unlocked');
    await noOverflow(page, 'Settings');
  });
}

test('keeps a draft, a revealed secret, the selection and the search across both breakpoints (D197)', async ({
  page,
}) => {
  await create(page, 1280);
  await newLogin(page);
  await page.getByTestId('search').fill('Harbor');
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  const secret = page.getByTestId('secret-Password');
  await expect(secret).toHaveText(SECRET);
  for (const width of [390, 800, 1280, 800, 390]) {
    await resize(page, width);
    await expect(page.getByRole('heading', { name: TITLE })).toBeVisible();
    await expect(secret).toHaveText(SECRET);
  }
  // Mobile shows the detail alone; the list behind it kept the search.
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByTestId('search')).toHaveValue('Harbor');
  await expect(page.getByRole('button', { name: TITLE, exact: true })).toBeVisible();

  // A draft, with its secret revealed, survives every width.
  await resize(page, 1280);
  await page.getByTestId('search').fill('');
  await page.getByRole('button', { name: 'New item', exact: true }).click();
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await page.getByTestId('item-title').fill('Draft title');
  const password = page.getByTestId('input-Password');
  await password.fill('Draft-Secret-0042');
  await password.locator('..').getByRole('button', { name: 'Show', exact: true }).click();
  await expect(password).not.toHaveAttribute('type', 'password');
  for (const width of [390, 800, 1280, 390]) {
    await resize(page, width);
    await expect(page.getByTestId('item-title')).toHaveValue('Draft title');
    await expect(password).toHaveValue('Draft-Secret-0042');
    await expect(password).not.toHaveAttribute('type', 'password');
  }
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Draft title' })).toBeVisible();
});

test('opens the tablet drawer over the list, and closes it by Escape, the backdrop or a choice (D197)', async ({
  page,
}) => {
  await create(page, 800);
  const toggle = page.getByRole('button', { name: 'Folders', exact: true });
  const allItems = folders(page).getByRole('button', { name: 'All items', exact: true });

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(folders(page)).toBeVisible();
  await expect(allItems).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(folders(page)).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toBeFocused();

  await toggle.click();
  await page.getByTestId('drawer-backdrop').click({ position: { x: 600, y: 300 } });
  await expect(folders(page)).toBeHidden();
  await expect(toggle).toBeFocused();

  await toggle.click();
  await folders(page).getByRole('button', { name: 'Trash', exact: true }).click();
  await expect(folders(page)).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Trash', exact: true })).toBeVisible();
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked');
});

test("goes one screen back on the browser's back, through one entry that carries nothing (D167, D197)", async ({
  page,
}) => {
  await create(page, 390);
  const before = await page.evaluate(() => window.history.length);
  await newLogin(page);
  const heading = page.getByRole('heading', { name: TITLE });
  const row = page.getByRole('button', { name: TITLE, exact: true });
  const entry = () =>
    page.evaluate(() => ({
      length: window.history.length,
      state: window.history.state as unknown,
    }));
  expect(await entry()).toEqual({ length: before + 1, state: null });

  await page.goBack();
  await expect(heading).toBeHidden();
  await expect(row).toBeVisible();
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked');

  // Deeper again: the same single entry, pushed again.
  await row.click();
  await expect(heading).toBeVisible();
  expect(await entry()).toEqual({ length: before + 1, state: null });
  await page.goBack();
  await expect(row).toBeVisible();

  // Settings on desktop goes back the same way.
  await resize(page, 1280);
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await expect(page.getByTestId('device-storage')).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('device-storage')).toBeHidden();
  await expect(page.getByRole('button', { name: 'New item', exact: true })).toBeVisible();

  expect(new URL(page.url()).pathname).toBe('/');
  expect(new URL(page.url()).search + new URL(page.url()).hash).toBe('');
});

test('starts a new item with N, never from a text field, the editor or the trash (D197)', async ({
  page,
}) => {
  await create(page, 1280);
  const picker = page.getByRole('button', { name: 'Login', exact: true });
  const blur = () =>
    page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });

  // In a text field, N is typed.
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('search')).toBeFocused();
  await page.keyboard.press('n');
  await expect(page.getByTestId('search')).toHaveValue('n');
  await expect(picker).toHaveCount(0);
  await page.getByTestId('search').fill('');

  await blur();
  await page.keyboard.press('n');
  await expect(picker).toBeVisible();
  await picker.click();
  await page.getByTestId('item-title').fill('Draft title');
  // The editor keeps its draft.
  await blur();
  await page.keyboard.press('n');
  await expect(page.getByTestId('item-title')).toHaveValue('Draft title');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

  await folders(page).getByRole('button', { name: 'Trash', exact: true }).click();
  await blur();
  await page.keyboard.press('n');
  await expect(picker).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Trash', exact: true })).toBeVisible();
});

test.describe('on a coarse pointer', () => {
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'Only Chromium emulates a touch screen with a coarse pointer (isMobile)',
  );
  test.use({ hasTouch: true, isMobile: true });

  /** Every visible control under 44 px tall; a checkbox or radio button counts by its label. */
  function smallTargets(page: Page): Promise<string[]> {
    return page.evaluate(() =>
      Array.from(
        document.querySelectorAll(
          'button, select, textarea, input:not([type=checkbox]):not([type=radio]), label:has(> input[type=checkbox]), label:has(> input[type=radio])',
        ),
      ).flatMap((e) => {
        const { width, height } = e.getBoundingClientRect();
        if (width === 0 || height >= 44) return [];
        const name = e.getAttribute('aria-label') ?? e.textContent.trim().slice(0, 40);
        return [`${e.tagName} "${name}" ${String(Math.round(height))}px`];
      }),
    );
  }

  test('makes every control at least 44 px tall, in every layout (D197)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto('/');
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await startScreen(page);
    expect(await smallTargets(page), 'the first screen').toEqual([]);
    await createVault(page, PASSWORD);
    await newLogin(page);

    for (const [layout, width] of WIDTHS) {
      await resize(page, width);
      if (layout === 'mobile') {
        expect(await smallTargets(page), `${layout}: an item`).toEqual([]);
        await page.getByRole('button', { name: 'Back', exact: true }).click();
      } else if (layout === 'tablet') {
        await page.getByRole('button', { name: 'Folders', exact: true }).click();
        await expect(folders(page)).toBeVisible();
        expect(await smallTargets(page), `${layout}: the drawer`).toEqual([]);
        await page.keyboard.press('Escape');
      }
      expect(await smallTargets(page), `${layout}: the vault`).toEqual([]);
      await page.getByRole('button', { name: 'New item', exact: true }).click();
      await page.getByRole('button', { name: 'Login', exact: true }).click();
      await page.getByRole('button', { name: 'Generate', exact: true }).click();
      await expect(page.getByTestId('generator-entropy')).toBeVisible();
      expect(await smallTargets(page), `${layout}: the editor and its generator`).toEqual([]);
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
      await expect(page.getByTestId('device-storage')).toBeVisible();
      expect(await smallTargets(page), `${layout}: Settings`).toEqual([]);
      await page.getByRole('button', { name: 'Back', exact: true }).click();
    }

    await page.getByRole('button', { name: 'Lock', exact: true }).click();
    await expect(page.getByTestId('unlock-password')).toBeVisible();
    expect(await smallTargets(page), 'the unlock screen').toEqual([]);
  });
});
