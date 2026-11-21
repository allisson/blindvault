// The function the extension injects to fill a page (extension.md §6.1, D287), run in pages of each
// engine: Playwright cannot load the extension's package in Firefox, so the page side of filling is
// tested here, in Chromium, Firefox and WebKit, and the extension's own pages in apps/extension/e2e.
// The choice of the frame among the probes' results is `fill.ts`'s, unit-tested in `fill.test.ts`.

import { type BrowserContext, type Frame, type Page, expect, test } from '@playwright/test';

import { type InPageOrder, inPage } from '../src/extension/inject';

const SITE = 'https://site.test';
const ADS = 'https://ads.test';

async function serve(context: BrowserContext, pages: Record<string, string>): Promise<void> {
  await context.route(/^https:\/\/(site|ads)\.test\//, (route) => {
    const body = pages[new URL(route.request().url()).href];
    return body === undefined
      ? route.fulfill({ status: 404, body: '' })
      : route.fulfill({ contentType: 'text/html', body: `<!doctype html>${body}` });
  });
}

/** Records the events a fill dispatches, and any submit. */
const RECORDER = `<script>
  window.seen = [];
  addEventListener('input', (e) => seen.push('input:' + e.target.name), true);
  addEventListener('change', (e) => seen.push('change:' + e.target.name), true);
  addEventListener('submit', (e) => { seen.push('submit'); e.preventDefault(); }, true);
  addEventListener('click', () => seen.push('click'), true);
  addEventListener('keydown', () => seen.push('keydown'), true);
</script>`;

async function open(page: Page, body: string): Promise<void> {
  await serve(page.context(), { [`${SITE}/login`]: RECORDER + body });
  await page.goto(`${SITE}/login`);
}

const run = (frame: Frame | Page, order: InPageOrder) => frame.evaluate(inPage, order);
const fill = (frame: Frame | Page, values: { username?: string; password?: string }) =>
  run(frame, { kind: 'fill', origin: SITE, ...values });
const value = (page: Page, selector: string) => page.locator(selector).inputValue();
const seen = (page: Page) => page.evaluate(() => (window as unknown as { seen: string[] }).seen);

test('fills the user name before the password field and the password, and never submits', async ({
  page,
}) => {
  await open(
    page,
    `<input name="search" type="search">
     <form action="/next"><input name="email" type="email"><input name="pass" type="password">
     <button>Sign in</button></form>`,
  );
  await expect(run(page, { kind: 'probe' })).resolves.toEqual({
    origin: SITE,
    password: true,
    focusedPassword: false,
    focusedText: false,
  });
  await expect(fill(page, { username: 'ana@example.com', password: 'hunter2' })).resolves.toBe(
    'filled',
  );
  expect(await value(page, '[name=email]')).toBe('ana@example.com');
  expect(await value(page, '[name=pass]')).toBe('hunter2');
  expect(await value(page, '[name=search]')).toBe('');
  expect(await seen(page)).toEqual(['input:email', 'change:email', 'input:pass', 'change:pass']);
  await expect(page).toHaveURL(`${SITE}/login`);
});

test('takes autocomplete="username", and a field of the password’s form only', async ({ page }) => {
  await open(
    page,
    `<input name="outside" type="text">
     <form><input name="user" autocomplete="username"><input name="nick" type="text">
     <input name="pass" type="password"></form>`,
  );
  await fill(page, { username: 'ana', password: 'p' });
  expect(await value(page, '[name=user]')).toBe('ana');
  expect(await value(page, '[name=nick]')).toBe('');
  expect(await value(page, '[name=outside]')).toBe('');
});

test('skips a field for a new password, and takes the focused password field', async ({ page }) => {
  await open(
    page,
    `<input name="new" type="password" autocomplete="new-password">
     <input name="current" type="password" autocomplete="current-password">
     <input name="other" type="password">`,
  );
  await fill(page, { password: 'p1' });
  expect(await value(page, '[name=current]')).toBe('p1');
  expect(await value(page, '[name=new]')).toBe('');
  await page.locator('[name=other]').focus();
  await expect(run(page, { kind: 'probe' })).resolves.toMatchObject({ focusedPassword: true });
  await fill(page, { password: 'p2' });
  expect(await value(page, '[name=other]')).toBe('p2');
});

test('finds no target on a sign-up page with new-password fields only', async ({ page }) => {
  await open(
    page,
    `<input name="a" type="password" autocomplete="new-password">
     <input name="b" type="password" autocomplete="new-password">`,
  );
  await expect(run(page, { kind: 'probe' })).resolves.toMatchObject({ password: false });
  await expect(fill(page, { password: 'p' })).resolves.toBe('no-target');
});

test('skips hidden, invisible, disabled and read-only fields', async ({ page }) => {
  await open(
    page,
    `<input name="h1" type="password" style="display:none">
     <input name="h2" type="password" style="visibility:hidden">
     <input name="h3" type="password" disabled>
     <input name="h4" type="password" readonly>
     <input name="ok" type="password">`,
  );
  await fill(page, { password: 'p' });
  for (const name of ['h1', 'h2', 'h3', 'h4']) expect(await value(page, `[name=${name}]`)).toBe('');
  expect(await value(page, '[name=ok]')).toBe('p');
});

test('finds the fields of an open shadow root', async ({ page }) => {
  await open(
    page,
    `<div id="host"></div><script>
       const root = document.getElementById('host').attachShadow({ mode: 'open' });
       root.innerHTML = '<form><input name="u"><input name="p" type="password"></form>';
     </script>`,
  );
  await expect(fill(page, { username: 'ana', password: 'p' })).resolves.toBe('filled');
  const values = await page.evaluate(() => {
    const root = document.getElementById('host')?.shadowRoot;
    return ['u', 'p'].map((n) => root?.querySelector<HTMLInputElement>(`[name=${n}]`)?.value);
  });
  expect(values).toEqual(['ana', 'p']);
});

test('fills a user name alone into the focused field of a page with no password field (D287)', async ({
  page,
}) => {
  await open(page, `<input name="email" type="email"><input name="other" type="text">`);
  await expect(run(page, { kind: 'probe' })).resolves.toMatchObject({
    password: false,
    focusedText: false,
  });
  await expect(fill(page, { username: 'ana', password: 'p' })).resolves.toBe('no-target');
  await page.locator('[name=email]').focus();
  await expect(run(page, { kind: 'probe' })).resolves.toMatchObject({ focusedText: true });
  await expect(fill(page, { username: 'ana', password: 'p' })).resolves.toBe('filled');
  expect(await value(page, '[name=email]')).toBe('ana');
  expect(await value(page, '[name=other]')).toBe('');
});

test('writes nothing when the page’s origin is no longer the expected one', async ({ page }) => {
  await open(page, `<input name="u"><input name="p" type="password">`);
  await expect(
    run(page, { kind: 'fill', origin: ADS, username: 'ana', password: 'p' }),
  ).resolves.toBe('moved');
  expect(await value(page, '[name=p]')).toBe('');
  expect(await seen(page)).toEqual([]);
});

test('never targets a cross-origin iframe, even with its password field focused', async ({
  page,
}) => {
  await serve(page.context(), {
    [`${SITE}/login`]: `<p>No sign-in here.</p><iframe src="${ADS}/frame"></iframe>`,
    [`${ADS}/frame`]: `<input name="p" type="password" autofocus>`,
  });
  await page.goto(`${SITE}/login`);
  const ads = page.frames().find((f) => f.url().startsWith(ADS));
  if (!ads) throw new Error('no iframe');
  await ads.locator('[name=p]').focus();
  // The probe reports the iframe's own origin, which `chooseFrame` never takes for the top
  // frame's; the top frame has no field to fill.
  await expect(run(ads, { kind: 'probe' })).resolves.toMatchObject({
    origin: ADS,
    focusedPassword: true,
  });
  await expect(run(page, { kind: 'probe' })).resolves.toEqual({
    origin: SITE,
    password: false,
    focusedPassword: false,
    focusedText: false,
  });
  await expect(fill(page, { password: 'p' })).resolves.toBe('no-target');
});
