import { type Browser, type Page, expect, test } from '@playwright/test';

import { deniedCamera, expectCameraReleased, fakeQrCamera, noCamera, showQr } from './camera';
import { createVault, openVault, startScreen } from './create';
import { PAIRING_URL } from '../playwright.config';
import { fillPassword } from './password';

// A pairing by QR codes both ways (D4, D208): each device shows its payload as a code and scans the
// other's with its camera, same network only. The camera is a canvas showing the other page's code
// (e2e/camera.ts); the scanning side still opens the browser's fake camera first, as a phone does.

// Creation, A's password again and B's password each run Argon2id at about 1 s (D9).
test.setTimeout(240_000);

test.beforeEach(({ browserName }) => {
  // The skip of pairing.spec.ts: the canvas is not a capture, so this does not show that WebKit on
  // Linux connects (D208).
  test.skip(
    browserName === 'webkit' && process.platform === 'linux',
    'WebKit on Linux does not connect over mDNS names only',
  );
});

test.use({ baseURL: PAIRING_URL });

const PASSWORD_A = 'quartz-lantern-velvet-harbor-9214';
const PASSWORD_B = 'meadow-copper-signal-anchor-3071';
const TITLE = 'Harbor Bank';

function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

type Camera = (context: import('@playwright/test').BrowserContext) => Promise<void>;

async function device(
  browser: Browser,
  browserName: string,
  camera: Camera = fakeQrCamera,
  requests: string[] = [],
): Promise<Page> {
  // Firefox takes no camera permission per context: its fake camera has no prompt (config).
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    ...(browserName === 'firefox' ? {} : { permissions: ['camera'] }),
  });
  await camera(context);
  const page = await context.newPage();
  page.on('request', (request) => requests.push(request.url()));
  await page.goto('/');
  return page;
}

/** A holds a vault with one item and shows its pairing code. */
async function invite(a: Page): Promise<void> {
  await createVault(a, PASSWORD_A);
  await button(a, 'New item').click();
  await button(a, 'Login').click();
  await a.getByTestId('item-title').fill(TITLE);
  await button(a, 'Save').click();
  await expect(a.getByRole('heading', { name: TITLE })).toBeVisible();
  await button(a, 'Settings').click();
  await button(a, 'Pair a new device…').click();
  await a.getByTestId('pairing-same-network').check();
  await fillPassword(a.getByTestId('invite-password'), PASSWORD_A);
  await button(a, 'Start pairing').click();
  await expect(a.getByTestId('pairing-qr')).toBeVisible({ timeout: 30_000 });
}

/** B, with no vault, creates its password and reaches the screen that takes A's code or text. */
async function join(b: Page): Promise<void> {
  await startScreen(b);
  await button(b, 'Pair with an existing device').click();
  await fillPassword(b.getByTestId('new-password'), PASSWORD_B);
  await fillPassword(b.getByTestId('confirm-password'), PASSWORD_B);
  await b.getByTestId('pairing-same-network').check();
  await button(b, 'Continue').click();
  await expect(b.getByTestId('pairing-paste')).toBeVisible({ timeout: 30_000 });
}

test('pairs by QR codes both ways: B scans A, A scans B, then B holds the vault (D4, D208)', async ({
  browser,
  browserName,
}) => {
  const requests: string[] = [];
  const a = await device(browser, browserName, fakeQrCamera, requests);
  const b = await device(browser, browserName, fakeQrCamera, requests);
  await invite(a);
  // The code is the payload's text, the one shown below it.
  const offer = await a.getByTestId('pairing-text').inputValue();
  await join(b);

  // B scans A's code: the text read goes in the field, and B shows its answer.
  await showQr(a, b);
  await b.getByTestId('scan-start').click();
  await expect(b.getByTestId('pairing-qr')).toBeVisible({ timeout: 30_000 });
  await expectCameraReleased(b);
  const answer = await b.getByTestId('pairing-text').inputValue();
  expect(answer).not.toBe(offer);

  // A first scans its own code: refused as a pasted one would be, the camera still open.
  await a.getByTestId('scan-start').click();
  await showQr(a, a);
  await expect(a.getByTestId('pairing-paste')).toHaveValue(offer);
  await expect(
    a.getByText('This is not a BlindVault pairing text. Copy it again, whole.'),
  ).toBeVisible();
  await expect(a.getByTestId('scan-video')).toBeVisible();
  // Then B's code: taken, both reach the same numbers.
  await showQr(b, a);
  const sasA = a.getByTestId('pairing-sas');
  await expect(sasA).toHaveText(/^\d{3} \d{3}$/, { timeout: 30_000 });
  await expect(b.getByTestId('pairing-sas')).toHaveText((await sasA.textContent()) ?? '', {
    timeout: 30_000,
  });
  await expectCameraReleased(a);

  await button(a, 'Yes, the same').click();
  await button(b, 'Yes, the same').click();
  await expect(b.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: 60_000 });
  await openVault(b);
  await expect(b.getByRole('button', { name: new RegExp(TITLE) })).toBeVisible();
  await expect(a.getByTestId('pairing-done')).toContainText('is paired', { timeout: 60_000 });

  // The reader's WASM came from this origin, and nothing went anywhere else (D91, D208).
  expect(requests.some((url) => url.startsWith(`${PAIRING_URL}/assets/zxing_reader-`))).toBe(true);
  expect(
    requests.filter((url) => !url.startsWith(PAIRING_URL) && !url.startsWith('blob:')),
  ).toEqual([]);
});

test('leaving the scan stops the camera, before anything is read (D208)', async ({
  browser,
  browserName,
}) => {
  const b = await device(browser, browserName);
  await join(b);
  await b.getByTestId('scan-start').click();
  await expect(b.getByTestId('scan-video')).toBeVisible();
  await expect.poll(() => b.evaluate(() => window.__camera.tracks.length)).toBeGreaterThan(0);
  await b.getByTestId('scan-stop').click();
  await expectCameraReleased(b);
  // Cancelling the pairing from the viewfinder also lets the camera go.
  await b.getByTestId('scan-start').click();
  await expect(b.getByTestId('scan-video')).toBeVisible();
  await expect
    .poll(() =>
      b.evaluate(() => window.__camera.tracks.filter((t) => t.readyState === 'live').length),
    )
    .toBeGreaterThan(0);
  await b.getByTestId('pairing-cancel').click();
  await expectCameraReleased(b);
});

test('a denied camera says so, and pasting still works (D208)', async ({
  browser,
  browserName,
}) => {
  const a = await device(browser, browserName, fakeQrCamera);
  const b = await device(browser, browserName, deniedCamera);
  await invite(a);
  await join(b);
  await b.getByTestId('scan-start').click();
  await expect(b.getByTestId('scan-problem')).toHaveText(
    'The camera was denied: allow it in the browser settings, or paste the text.',
  );
  await b.getByTestId('pairing-paste').fill(await a.getByTestId('pairing-text').inputValue());
  await button(b, 'Continue').click();
  await expect(b.getByTestId('pairing-qr')).toBeVisible({ timeout: 30_000 });
});

test('a browser with no camera offers only the paste (D208)', async ({ browser, browserName }) => {
  const b = await device(browser, browserName, noCamera);
  await join(b);
  await expect(b.getByText('This device has no camera: paste the text.')).toBeVisible();
  await expect(b.getByTestId('scan-start')).toHaveCount(0);
  await expect(b.getByTestId('pairing-paste')).toBeVisible();
});
