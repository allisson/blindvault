import { type Browser, type Page, expect, test } from '@playwright/test';

import type { Harness } from './harness';

// The first real WebRTC connection of a pairing (`pairing-protocol.md` §3, §4): two pages in two
// browser contexts, LAN-only (no STUN), exchanging only the base45 payload texts.

const MAX_MESSAGE_LENGTH = 65_535;
const MAX_CHANNEL_MESSAGE_LENGTH = MAX_MESSAGE_LENGTH - 16;

/**
 * One device in its own browser context. The scanning device (B, the responder) holds the camera
 * before it gathers, as in QR pairing (D161): its host candidate is then a raw IP address. Without
 * it both sides send only mDNS names, which the Linux CI runner does not resolve for WebKit; that
 * case is measured on real devices (roadmap, Phase 4).
 */
async function device(browser: Browser, camera = false): Promise<{ page: Page }> {
  const firefox = browser.browserType().name() === 'firefox';
  const context = await browser.newContext(camera && !firefox ? { permissions: ['camera'] } : {});
  const page = await context.newPage();
  await page.goto('/');
  await page.waitForFunction(() => 'harness' in window);
  if (camera) await page.evaluate(() => window.harness.holdCamera());
  return { page };
}

function checksum(length: number, seed: number) {
  let sum = 0;
  for (let i = 0; i < length; i++) sum = (sum + ((i * 31 + seed) & 0xff) * (i + 1)) % 1_000_003;
  return { length, sum };
}

async function pair(browser: Browser) {
  const a = await device(browser);
  const b = await device(browser, true);
  const offer = await a.page.evaluate(() => window.harness.startInitiator());
  const answer = await b.page.evaluate((text) => window.harness.startResponder(text), offer);
  return { a, b, offer, answer };
}

declare global {
  interface Window {
    harness: Harness;
  }
}

test('two devices connect from the payloads alone and carry messages both ways', async ({
  browser,
}) => {
  const { a, b, offer, answer } = await pair(browser);
  expect(offer).toMatch(/^[0-9A-Z $%*+\-./:]+$/);
  expect(answer).toMatch(/^[0-9A-Z $%*+\-./:]+$/);

  expect(await a.page.evaluate((text) => window.harness.accept(text), answer)).toBe('open');
  expect(await b.page.evaluate(() => window.harness.connected())).toBe('open');

  for (const [from, to, length, seed] of [
    [a, b, 1, 1],
    [b, a, 300, 2],
    [a, b, MAX_MESSAGE_LENGTH, 3],
    [b, a, MAX_MESSAGE_LENGTH, 4],
  ] as const) {
    await from.page.evaluate(([l, s]) => window.harness.send(l, s), [length, seed] as const);
    expect(await to.page.evaluate(() => window.harness.receive())).toEqual(checksum(length, seed));
  }

  expect(await a.page.evaluate(() => window.harness.close())).toBe('local');
  expect(await b.page.evaluate(() => window.harness.closed())).toBe('remote');
});

// The pairing handshake over the real DataChannel (`pairing-protocol.md` §5, §10.1).
test('the two devices run Noise_XX over the connection and talk through the Noise channel', async ({
  browser,
}) => {
  const { a, b, answer } = await pair(browser);
  expect(await a.page.evaluate((text) => window.harness.accept(text), answer)).toBe('open');
  expect(await b.page.evaluate(() => window.harness.connected())).toBe('open');

  const [onA, onB] = await Promise.all([
    a.page.evaluate(() => window.harness.handshake()),
    b.page.evaluate(() => window.harness.handshake()),
  ]);
  expect(onA.hash).toMatch(/^[0-9a-f]{128}$/);
  expect(onA.hash).toBe(onB.hash);
  expect(onA.peer).toBe(onB.self);
  expect(onB.peer).toBe(onA.self);

  for (const [from, to, length, seed] of [
    [b, a, 1, 5],
    [a, b, MAX_CHANNEL_MESSAGE_LENGTH, 6],
    [b, a, MAX_CHANNEL_MESSAGE_LENGTH, 7],
  ] as const) {
    await from.page.evaluate(([l, s]) => window.harness.channelSend(l, s), [length, seed] as const);
    expect(await to.page.evaluate(() => window.harness.channelReceive())).toEqual(
      checksum(length, seed),
    );
  }

  expect(await b.page.evaluate(() => window.harness.channelClose())).toBe('local');
  expect(await a.page.evaluate(() => window.harness.channelClosed())).toBe('remote');
});

// Nonces, SAS and confirmation over the real DataChannel (`pairing-protocol.md` §6, §10).
test('the two devices show the same SAS and both confirm it', async ({ browser }) => {
  const { a, b, answer } = await pair(browser);
  expect(await a.page.evaluate((text) => window.harness.accept(text), answer)).toBe('open');
  expect(await b.page.evaluate(() => window.harness.connected())).toBe('open');

  const [sasA, sasB] = await Promise.all([
    a.page.evaluate(() => window.harness.sas()),
    b.page.evaluate(() => window.harness.sas()),
  ]);
  expect(sasA).toMatch(/^\d{6}$/);
  expect(sasA).toBe(sasB);
  expect(
    await Promise.all([
      a.page.evaluate(() => window.harness.confirmSas()),
      b.page.evaluate(() => window.harness.confirmSas()),
    ]),
  ).toEqual(['confirmed', 'confirmed']);
});

test('a SAS rejected on one device aborts the session on the other', async ({ browser }) => {
  const { a, b, answer } = await pair(browser);
  expect(await a.page.evaluate((text) => window.harness.accept(text), answer)).toBe('open');
  expect(await b.page.evaluate(() => window.harness.connected())).toBe('open');
  await Promise.all([
    a.page.evaluate(() => window.harness.sas()),
    b.page.evaluate(() => window.harness.sas()),
  ]);

  const waiting = a.page.evaluate(() => window.harness.confirmSas());
  await b.page.evaluate(() => window.harness.rejectSas());
  expect(await waiting).toBe('sas-mismatch:remote');
  expect(await b.page.evaluate(() => window.harness.sessionEnded())).toBe('sas-mismatch:local');
});

test('an answer for another session is refused, and the right one still connects once', async ({
  browser,
}) => {
  const { a, b, answer } = await pair(browser);
  expect(
    await a.page.evaluate((text) => window.harness.acceptForAnotherSession(text), answer),
  ).toBe('wrong-session');
  expect(await a.page.evaluate((text) => window.harness.accept(text), answer)).toBe('open');
  expect(await b.page.evaluate(() => window.harness.connected())).toBe('open');
  expect(await a.page.evaluate((text) => window.harness.accept(text), answer)).toBe(
    'wrong-session',
  );
});

test('every session has a new DTLS certificate', async ({ browser }) => {
  const a = await device(browser);
  await a.page.evaluate(() => window.harness.startInitiator());
  const first = await a.page.evaluate(() => window.harness.fingerprint());
  await a.page.evaluate(() => window.harness.startInitiator());
  expect(await a.page.evaluate(() => window.harness.fingerprint())).not.toBe(first);
});

// The browser refuses a DTLS certificate other than the one in the payload (§4).
for (const side of ['offer', 'answer'] as const) {
  test(`a payload with another DTLS fingerprint in the ${side} never connects`, async ({
    browser,
  }) => {
    const a = await device(browser);
    const b = await device(browser, true);
    const offer = await a.page.evaluate(() => window.harness.startInitiator());
    const answer = await b.page.evaluate(
      ([text, tamper]) => window.harness.startResponder(text, tamper),
      [offer, side === 'offer'] as const,
    );
    const [onA, onB] = await Promise.all([
      a.page.evaluate(([text, tamper]) => window.harness.accept(text, tamper, 10_000), [
        answer,
        side === 'answer',
      ] as const),
      b.page.evaluate(() => window.harness.connected(10_000)),
    ]);
    expect(onA).not.toBe('open');
    expect(onB).not.toBe('open');
  });
}

test('aborting the session closes the connection before it opens', async ({ browser }) => {
  const { a, answer } = await pair(browser);
  await a.page.evaluate(() => {
    window.harness.abort();
  });
  expect(await a.page.evaluate((text) => window.harness.accept(text), answer)).toBe('closed:local');
});

// The connection of a sync (`sync-protocol.md` §4, §5, D216): the same link, its fields sealed in
// the reconnection payload with `Noise_K`, opened only with the picked peer's key.
test('two registered devices connect from their reconnection payloads and carry messages', async ({
  browser,
}) => {
  const a = await device(browser);
  const b = await device(browser, true);
  const c = await device(browser);
  const keyA = await a.page.evaluate(() => window.harness.syncIdentity());
  const keyB = await b.page.evaluate(() => window.harness.syncIdentity());
  await c.page.evaluate(() => window.harness.syncIdentity());
  await a.page.evaluate((key) => {
    window.harness.syncPeer(key);
  }, keyB);
  await b.page.evaluate((key) => {
    window.harness.syncPeer(key);
  }, keyA);
  await c.page.evaluate((key) => {
    window.harness.syncPeer(key);
  }, keyB);

  // C seals to B too, but B picked A: C's offer does not open.
  const fromC = await c.page.evaluate(() => window.harness.startSyncInitiator());
  expect(await b.page.evaluate((text) => window.harness.startSyncResponder(text), fromC)).toBe(
    'not-from-peer',
  );

  const offer = await a.page.evaluate(() => window.harness.startSyncInitiator());
  expect(offer).toMatch(/^[0-9A-Z $%*+\-./:]+$/);
  const answer = await b.page.evaluate((text) => window.harness.startSyncResponder(text), offer);
  // I's own offer handed back to it is not R's answer.
  expect(await a.page.evaluate((text) => window.harness.acceptSync(text), offer)).toBe(
    'not-from-peer',
  );
  expect(await a.page.evaluate((text) => window.harness.acceptSync(text), answer)).toBe('open');
  expect(await b.page.evaluate(() => window.harness.connected())).toBe('open');

  for (const [from, to, length, seed] of [
    [a, b, 1, 8],
    [b, a, MAX_MESSAGE_LENGTH, 9],
  ] as const) {
    await from.page.evaluate(([l, s]) => window.harness.send(l, s), [length, seed] as const);
    expect(await to.page.evaluate(() => window.harness.receive())).toEqual(checksum(length, seed));
  }
  expect(await b.page.evaluate(() => window.harness.close())).toBe('local');
  expect(await a.page.evaluate(() => window.harness.closed())).toBe('remote');
});
