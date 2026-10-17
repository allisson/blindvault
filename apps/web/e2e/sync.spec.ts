import { type Browser, type Page, expect, test } from '@playwright/test';

import { createVault, startScreen } from './create';
import { PAIRING_URL } from '../playwright.config';
import { fillPassword } from './password';

// The manual sync flow between two paired installations, each in its own browser context, through
// the screens alone (§9.1, sync-protocol.md §3 to §5, D216): the user picks the other device on
// both, one shows its code first, the codes are copied and pasted, the same network only (no STUN
// server), and both connect. Nothing is sent before Noise_KK, which comes with its task.

// Creation, A's password again and B's password each run Argon2id at about 1 s (D9).
test.setTimeout(240_000);

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

function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

async function device(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto('/');
  return page;
}

/** A creates a vault and pairs B by copy/paste; both end in Settings › Devices. */
async function paired(browser: Browser) {
  const a = await device(browser);
  const b = await device(browser);
  await createVault(a, PASSWORD_A);
  await button(a, 'Settings').click();
  await button(a, 'Pair a new device…').click();
  await a.getByTestId('pairing-same-network').check();
  await fillPassword(a.getByTestId('invite-password'), PASSWORD_A);
  await button(a, 'Start pairing').click();
  const offer = a.getByTestId('pairing-text');
  await expect(offer).not.toHaveValue('', { timeout: 30_000 });

  await startScreen(b);
  await button(b, 'Pair with an existing device').click();
  await fillPassword(b.getByTestId('new-password'), PASSWORD_B);
  await fillPassword(b.getByTestId('confirm-password'), PASSWORD_B);
  await b.getByTestId('pairing-same-network').check();
  await button(b, 'Continue').click();
  await b.getByTestId('pairing-paste').fill(await offer.inputValue(), { timeout: 30_000 });
  await button(b, 'Continue').click();
  const answer = b.getByTestId('pairing-text');
  await expect(answer).not.toHaveValue('', { timeout: 30_000 });
  await a.getByTestId('pairing-paste').fill(await answer.inputValue());
  await button(a, 'Connect').click();
  await expect(a.getByTestId('pairing-sas')).toBeVisible({ timeout: 30_000 });
  await button(a, 'Yes, the same').click();
  await button(b, 'Yes, the same').click();
  await expect(b.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 60_000 });
  await expect(a.getByTestId('pairing-done')).toBeVisible({ timeout: 60_000 });
  await button(a, 'Done').click();
  await button(b, 'Settings').click();
  return { a, b };
}

test('two paired devices connect from their sync codes, each with the other picked (D216)', async ({
  browser,
}) => {
  const { a, b } = await paired(browser);

  // Each picks the other device; A shows its code first, B reads it.
  await a.getByTestId('device-sync').click();
  const syncA = a.getByTestId('sync');
  await syncA.getByTestId('pairing-same-network').check();
  await syncA.getByTestId('sync-first').click();
  const offer = syncA.getByTestId('pairing-text');
  await expect(offer).not.toHaveValue('', { timeout: 30_000 });
  const offerText = await offer.inputValue();
  expect(offerText).toMatch(/^[0-9A-Z $%*+\-./:]+$/);
  await expect(syncA).toContainText('encrypted for');

  await b.getByTestId('device-sync').click();
  const syncB = b.getByTestId('sync');
  await syncB.getByTestId('pairing-same-network').check();
  await syncB.getByTestId('sync-read').click();
  await syncB.getByTestId('pairing-paste').fill(offerText);
  await button(b, 'Next').click();
  const answer = syncB.getByTestId('pairing-text');
  await expect(answer).not.toHaveValue('', { timeout: 30_000 });

  // A's own code handed back to it is refused, and A keeps waiting (§4.3, D215).
  await syncA.getByTestId('pairing-paste').fill(offerText);
  await button(a, 'Connect').click();
  await expect(syncA).toContainText('This code is not from');
  await syncA.getByTestId('pairing-paste').fill(await answer.inputValue());
  await button(a, 'Connect').click();

  await expect(a.getByTestId('sync-connected')).toBeVisible({ timeout: 30_000 });
  await expect(b.getByTestId('sync-connected')).toBeVisible({ timeout: 30_000 });

  // Closing on A ends B's connection.
  await a.getByTestId('sync-close').click();
  await expect(a.getByTestId('sync')).toHaveCount(0);
  await expect(b.getByTestId('sync-failed')).toHaveAttribute('data-reason', 'closed', {
    timeout: 30_000,
  });
});
