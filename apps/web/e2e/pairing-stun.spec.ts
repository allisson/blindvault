import { type Browser, type Page, expect, test } from '@playwright/test';

import { createVault, startScreen } from './create';
import { PAIRING_URL } from '../playwright.config';
import { fillPassword } from './password';

// The STUN list (D209): edited on the pairing screens, kept in `localStorage`, and handed to
// `RTCPeerConnection` as the session's ICE servers. A stored list that cannot be read uses no STUN
// server at all: the same network only is then on and cannot be turned off.

// Creation, A's password again and B's password each run Argon2id at about 1 s (D9).
test.setTimeout(240_000);

// Firefox gathers no ICE candidate on `localhost`: this spec runs on 127.0.0.1 (playwright.config.ts).
test.use({ baseURL: PAIRING_URL });

const PASSWORD_A = 'quartz-lantern-velvet-harbor-9214';
const PASSWORD_B = 'meadow-copper-signal-anchor-3071';
const STORAGE_KEY = 'blindvault.stun';

function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

/** A device whose every `RTCPeerConnection` records the ICE servers it was given. */
async function device(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    const Original = window.RTCPeerConnection;
    const seen: unknown[] = [];
    Object.assign(window, { iceServersSeen: seen });
    window.RTCPeerConnection = class extends Original {
      constructor(config?: RTCConfiguration) {
        seen.push(JSON.parse(JSON.stringify(config?.iceServers ?? null)));
        super(config);
      }
    };
  });
  const page = await context.newPage();
  await page.goto('/');
  return page;
}

async function iceServersSeen(page: Page): Promise<unknown[]> {
  return page.evaluate(() => (window as unknown as { iceServersSeen: unknown[] }).iceServersSeen);
}

async function stored(page: Page): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
}

/** A stored list the app cannot read, then the pair start's join screen. */
async function unreadableJoin(b: Page): Promise<void> {
  await b.evaluate((key) => {
    localStorage.setItem(key, '["turn:turn.example.org"]');
  }, STORAGE_KEY);
  await b.reload();
  await startScreen(b);
  await button(b, 'Pair with an existing device').click();
}

test('a STUN list of its own: refused when invalid, saved, used by the pairing, then reset (D209)', async ({
  browser,
}) => {
  const a = await device(browser);
  await createVault(a, PASSWORD_A);
  await button(a, 'Settings').click();
  await button(a, 'Pair a new device…').click();
  const hint = a.getByTestId('same-network-hint');
  await expect(hint).toContainText('(stun.l.google.com, stun.cloudflare.com)');
  await a.getByTestId('stun-open').click();
  const list = a.getByTestId('stun-list').getByRole('listitem');
  await expect(list).toHaveText(['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478']);
  await expect(a.getByTestId('stun-reset')).toHaveCount(0);

  // Refused: TURN, a query and an empty list. Nothing is stored.
  await a.getByTestId('stun-edit').click();
  const text = a.getByTestId('stun-text');
  await expect(text).toHaveValue('stun:stun.l.google.com:19302\nstun:stun.cloudflare.com:3478');
  for (const [value, message] of [
    [
      'stun:127.0.0.1:3478\nturn:turn.example.org:3478',
      '“turn:turn.example.org:3478” is not a STUN server',
    ],
    ['stun:127.0.0.1:3478?transport=udp', 'nothing after “?” is accepted'],
    [' \n', 'Enter at least one STUN server'],
  ] as const) {
    await text.fill(value);
    await a.getByTestId('stun-save').click();
    await expect(a.getByText(message)).toBeVisible();
  }
  expect(await stored(a)).toBeNull();

  // Saved: lowercased, blank lines skipped and duplicates dropped.
  await text.fill('stun:127.0.0.1:3478\n\nSTUN:Stun.Invalid:3479\nstun:127.0.0.1:3478');
  await a.getByTestId('stun-save').click();
  await expect(list).toHaveText(['stun:127.0.0.1:3478', 'stun:stun.invalid:3479']);
  await expect(hint).toContainText('(127.0.0.1, stun.invalid)');
  expect(await stored(a)).toBe('["stun:127.0.0.1:3478","stun:stun.invalid:3479"]');

  // The pairing hands exactly that list to the connection.
  await fillPassword(a.getByTestId('invite-password'), PASSWORD_A);
  await button(a, 'Start pairing').click();
  await expect(a.getByTestId('pairing-text')).not.toHaveValue('', { timeout: 30_000 });
  expect(await iceServersSeen(a)).toEqual([
    [{ urls: 'stun:127.0.0.1:3478' }, { urls: 'stun:stun.invalid:3479' }],
  ]);
  await button(a, 'Cancel').click();

  // Cancelled, the screen reads the list again: it stays, until the defaults are restored.
  await expect(a.getByTestId('invite-password')).toBeVisible();
  await a.getByTestId('stun-open').click();
  await expect(list).toHaveText(['stun:127.0.0.1:3478', 'stun:stun.invalid:3479']);
  await a.getByTestId('stun-reset').click();
  await expect(list).toHaveText(['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478']);
  await expect(hint).toContainText('(stun.l.google.com, stun.cloudflare.com)');
  expect(await stored(a)).toBeNull();

  // The same network only hides the list and uses no STUN server.
  await a.getByTestId('pairing-same-network').check();
  await expect(a.getByTestId('stun')).toHaveCount(0);
  await fillPassword(a.getByTestId('invite-password'), PASSWORD_A);
  await button(a, 'Start pairing').click();
  await expect(a.getByTestId('pairing-text')).not.toHaveValue('', { timeout: 30_000 });
  expect((await iceServersSeen(a)).at(-1)).toEqual([]);
});

test('an unreadable stored list: the same network only, locked on, and the pairing still reaches the SAS (D209)', async ({
  browser,
  browserName,
}) => {
  // Copy/paste with no camera: both sides send only mDNS names (pairing.spec.ts).
  test.skip(
    browserName === 'webkit' && process.platform === 'linux',
    'WebKit on Linux does not connect over mDNS names only',
  );
  const a = await device(browser);
  const b = await device(browser);

  await createVault(a, PASSWORD_A);
  await button(a, 'Settings').click();
  await button(a, 'Pair a new device…').click();
  await a.getByTestId('pairing-same-network').check();
  await fillPassword(a.getByTestId('invite-password'), PASSWORD_A);
  await button(a, 'Start pairing').click();
  const offerText = a.getByTestId('pairing-text');
  await expect(offerText).not.toHaveValue('', { timeout: 30_000 });
  const offer = await offerText.inputValue();

  await unreadableJoin(b);
  const sameNetwork = b.getByTestId('pairing-same-network');
  await expect(sameNetwork).toBeChecked();
  await expect(sameNetwork).toBeDisabled();
  await expect(b.getByTestId('stun-unreadable')).toContainText('cannot be read');
  await expect(b.getByTestId('stun-list')).toHaveCount(0);
  await fillPassword(b.getByTestId('new-password'), PASSWORD_B);
  await fillPassword(b.getByTestId('confirm-password'), PASSWORD_B);
  await button(b, 'Continue').click();
  await b.getByTestId('pairing-paste').fill(offer, { timeout: 30_000 });
  await button(b, 'Continue').click();
  const answerText = b.getByTestId('pairing-text');
  await expect(answerText).not.toHaveValue('', { timeout: 30_000 });
  expect(await iceServersSeen(b)).toEqual([[]]);

  await a.getByTestId('pairing-paste').fill(await answerText.inputValue());
  await button(a, 'Connect').click();
  const sasA = a.getByTestId('pairing-sas');
  const sasB = b.getByTestId('pairing-sas');
  await expect(sasA).toHaveText(/^\d{3} \d{3}$/, { timeout: 30_000 });
  await expect(sasB).toHaveText(/^\d{3} \d{3}$/, { timeout: 30_000 });
  expect(await sasB.textContent()).toBe(await sasA.textContent());
});

test('an unreadable stored list is fixed by restoring the defaults (D209)', async ({ browser }) => {
  const b = await device(browser);
  await unreadableJoin(b);
  await expect(b.getByTestId('stun-unreadable')).toBeVisible();
  await b.getByTestId('stun-reset').click();
  const sameNetwork = b.getByTestId('pairing-same-network');
  await expect(sameNetwork).toBeEnabled();
  await expect(sameNetwork).not.toBeChecked();
  await expect(b.getByTestId('stun-unreadable')).toHaveCount(0);
  await expect(b.getByTestId('same-network-hint')).toContainText(
    '(stun.l.google.com, stun.cloudflare.com)',
  );
  expect(await stored(b)).toBeNull();
});
