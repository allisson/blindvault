// Automated accessibility checks on the screens a second device opens (D238, UX Gate): the
// pairing texts, the SAS comparison, its results, the sync codes, a sync connected and ended, and
// the live sync in the vault, in both themes at the three layout widths.

import { type Browser, type Page, expect, test } from '@playwright/test';

import { THEMES, WIDTHS, audit } from './axe';
import { createVault, startScreen } from './create';
import { PAIRING_URL } from '../playwright.config';
import { fillPassword } from './password';

// Creation, A's password again and B's password each run Argon2id at about 1 s (D9).
test.setTimeout(300_000);

test.beforeEach(({ browserName }) => {
  // Copy/paste with no camera: both sides send only mDNS names, which WebKit does not connect on
  // the Linux runner (architecture.md, D203).
  test.skip(
    browserName === 'webkit' && process.platform === 'linux',
    'WebKit on Linux does not connect over mDNS names only',
  );
});

// Firefox gathers no ICE candidate on `localhost`: this spec runs on 127.0.0.1 (playwright.config.ts).
test.use({ baseURL: PAIRING_URL });

const PASSWORD_A = 'quartz-lantern-velvet-harbor-9214';
const PASSWORD_B = 'meadow-copper-signal-anchor-3071';

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

async function device(
  browser: Browser,
  width: number,
  theme: (typeof THEMES)[number],
): Promise<Page> {
  // Reduced motion measures each screen at rest, not halfway through its entrance (D236).
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    colorScheme: theme,
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  await page.goto('/');
  return page;
}

/** Goes back to Settings from wherever the vault is (on mobile, through Back). */
async function settings(page: Page): Promise<void> {
  const open = page.getByRole('button', { name: 'Settings' }).first();
  while (!(await open.isVisible())) await button(page, 'Back').click();
  await open.click();
}

for (const [layout, width] of WIDTHS) {
  for (const theme of THEMES) {
    test(`axe finds no violation on the pairing and sync screens, ${layout}, ${theme} theme (D238)`, async ({
      browser,
    }) => {
      const a = await device(browser, width, theme);
      const b = await device(browser, width, theme);

      // Pairing: A's text, B's answer, the SAS on both, then each side's result.
      await createVault(a, PASSWORD_A);
      await settings(a);
      await button(a, 'Pair a device…').click();
      await audit(a, 'the pairing password');
      await a.getByTestId('pairing-same-network').check();
      await fillPassword(a.getByTestId('invite-password'), PASSWORD_A);
      await button(a, 'Start pairing').click();
      const offer = a.getByTestId('pairing-text');
      await expect(offer).not.toHaveValue('', { timeout: 30_000 });
      await audit(a, "A's pairing text");

      await startScreen(b);
      await button(b, 'Pair with an existing device').click();
      await fillPassword(b.getByTestId('new-password'), PASSWORD_B);
      await fillPassword(b.getByTestId('confirm-password'), PASSWORD_B);
      await b.getByTestId('pairing-same-network').check();
      await button(b, 'Start pairing').click();
      await expect(b.getByTestId('pairing-paste')).toBeVisible({ timeout: 30_000 });
      await audit(b, "B waiting for A's text");
      await b.getByTestId('pairing-paste').fill(await offer.inputValue());
      await button(b, 'Show my answer').click();
      const answer = b.getByTestId('pairing-text');
      await expect(answer).not.toHaveValue('', { timeout: 30_000 });
      await audit(b, "B's answer");

      await a.getByTestId('pairing-paste').fill(await answer.inputValue());
      await button(a, 'Connect').click();
      await expect(a.getByTestId('pairing-sas')).toBeVisible({ timeout: 30_000 });
      await expect(b.getByTestId('pairing-sas')).toBeVisible({ timeout: 30_000 });
      await audit(a, 'the SAS comparison on A');
      await audit(b, 'the SAS comparison on B');
      await button(a, 'Yes, the same').click();
      await expect(a.getByText('Waiting for the other device…')).toBeVisible();
      await audit(a, 'A waiting for B');
      await button(b, 'Yes, the same').click();
      await expect(b.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 60_000 });
      await audit(b, 'Vault ready after a pairing');
      await expect(a.getByTestId('pairing-done')).toBeVisible({ timeout: 60_000 });
      await audit(a, 'the paired device');
      await button(a, 'Close').click();
      await audit(a, 'Settings with two devices');

      // Sync: A's code, B's answer, connected on both, then live in the vault.
      await settings(b);
      await a.getByTestId('device-sync').click();
      const syncA = a.getByTestId('sync');
      await audit(a, 'the sync choice');
      await syncA.getByTestId('pairing-same-network').check();
      await syncA.getByTestId('sync-first').click();
      const code = syncA.getByTestId('pairing-text');
      await expect(code).not.toHaveValue('', { timeout: 30_000 });
      await audit(a, "A's sync code");
      await b.getByTestId('device-sync').click();
      const syncB = b.getByTestId('sync');
      await syncB.getByTestId('pairing-same-network').check();
      await syncB.getByTestId('sync-read').click();
      await syncB.getByTestId('pairing-paste').fill(await code.inputValue());
      await button(b, 'Show my answer').click();
      const reply = syncB.getByTestId('pairing-text');
      await expect(reply).not.toHaveValue('', { timeout: 30_000 });
      await audit(b, "B's sync answer");
      await syncA.getByTestId('pairing-paste').fill(await reply.inputValue());
      await button(a, 'Connect').click();
      await expect(a.getByTestId('sync-done')).toBeVisible({ timeout: 30_000 });
      await expect(b.getByTestId('sync-done')).toBeVisible({ timeout: 30_000 });
      await audit(a, 'a sync connected on A');
      await audit(b, 'a sync connected on B');
      await a.getByTestId('sync-close').click();
      while (await button(a, 'Back').isVisible()) await button(a, 'Back').click();
      await expect(a.getByTestId('live-sync')).toBeVisible();
      await audit(a, 'the live sync in the vault');

      await a.getByTestId('live-sync-end').click();
      await expect(b.getByTestId('sync-failed')).toHaveAttribute('data-reason', 'ended', {
        timeout: 30_000,
      });
      await audit(b, 'a sync ended by the peer');
    });
  }
}
