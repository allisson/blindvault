import { type Browser, type Page, expect, test } from '@playwright/test';

import type { Harness } from './harness';

// A person carries the responder's code to the initiator: the initiator reads the answer seconds
// after the responder made it, and the responder must still be waiting (`pairing-protocol.md` §11,
// D296). Both sides hold the camera before they gather, as in QR pairing (D161, D296).

test.setTimeout(60_000);

test.beforeEach(({ browserName }) => {
  test.skip(
    browserName === 'firefox',
    'Firefox fails a responder whose checks get no answer within seconds (D296)',
  );
});

async function device(browser: Browser): Promise<{ page: Page }> {
  const context = await browser.newContext({ permissions: ['camera'] });
  const page = await context.newPage();
  await page.goto('/');
  await page.waitForFunction(() => 'harness' in window);
  await page.evaluate(() => window.harness.holdCamera());
  return { page };
}

declare global {
  interface Window {
    harness: Harness;
  }
}

test('the responder still connects when the answer is read 15 s later', async ({ browser }) => {
  const a = await device(browser);
  const b = await device(browser);
  const offer = await a.page.evaluate(() => window.harness.startInitiator());
  const answer = await b.page.evaluate((text) => window.harness.startResponder(text), offer);
  expect(await b.page.evaluate(() => window.harness.connected(15_000))).toBe('pending');
  expect(await a.page.evaluate((text) => window.harness.accept(text), answer)).toBe('open');
  expect(await b.page.evaluate(() => window.harness.connected())).toBe('open');
});
