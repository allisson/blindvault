// Stored passkeys end to end (extension.md §7, D268, D289), on Chromium: the content scripts in a
// site's frames, the service worker's relay, the session host and the confirmation window. The test
// copy of the package grants `<all_urls>` in its manifest (`withHosts`), as the switch of Settings ›
// Passkeys would on the user's click, so the session host registers the scripts at start (§7.1).
// The run on `webauthn.io`, in Chrome and Firefox, is by hand (§12).

import { createHash, verify } from 'node:crypto';

import { type BrowserContext, type Page } from '@playwright/test';

import { createVault } from '../../web/e2e/create.ts';
import { expect, test, withHosts } from './fixtures';

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';
const SITE = 'https://site.test';
const ADS = 'https://ads.test';

test.use({ extensionPackage: withHosts(['<all_urls>']) });

/** A sign-in page with an iframe of another origin. */
async function site(context: BrowserContext): Promise<Page> {
  await context.route(/^https:\/\/(site|ads)\.test\//, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: route.request().url().startsWith(ADS)
        ? '<!doctype html><p>ad</p>'
        : `<!doctype html><p>site</p>
           <iframe src="${ADS}/frame" allow="publickey-credentials-create *; publickey-credentials-get *"></iframe>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${SITE}/login`);
  return page;
}

/** The session host, unlocked, once it registered the content scripts. */
async function host(context: BrowserContext, extensionId: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/index.html`);
  await createVault(page, PASSWORD);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const api = (
          globalThis as unknown as {
            chrome: { scripting: { getRegisteredContentScripts(): Promise<object[]> } };
          }
        ).chrome;
        return (await api.scripting.getRegisteredContentScripts()).length;
      }),
    )
    .toBe(2);
  return page;
}

/** The confirmation window the next request opens. */
function nextWindow(context: BrowserContext): Promise<Page> {
  return context.waitForEvent('page', (p) => p.url().includes('/confirm.html#'));
}

type Json = Record<string, unknown> & {
  readonly id: string;
  readonly response: Readonly<
    Record<
      'clientDataJSON' | 'authenticatorData' | 'signature' | 'userHandle' | 'publicKey',
      string
    >
  > & { readonly transports?: readonly string[] };
};

const decode = (text: string) => Buffer.from(text, 'base64url');

/** Runs in the page: a create of an ES256 passkey for the frame's own site. */
async function create(): Promise<{ instance: boolean; json: Json; extensions: unknown }> {
  const c = (await navigator.credentials.create({
    publicKey: {
      rp: { name: 'Site' },
      user: { id: new Uint8Array([1, 2, 3]), name: 'ana@site.test', displayName: 'Ana' },
      challenge: new Uint8Array(32).fill(1),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      extensions: { credProps: true },
    },
  })) as PublicKeyCredential;
  return {
    instance: c instanceof PublicKeyCredential,
    json: c.toJSON() as unknown as Json,
    extensions: c.getClientExtensionResults(),
  };
}

/** Runs in the page: the error name a create ends with. */
async function failedCreate(): Promise<string> {
  try {
    await navigator.credentials.create({
      publicKey: {
        rp: { name: 'Site' },
        user: { id: new Uint8Array([4]), name: 'bia', displayName: 'Bia' },
        challenge: new Uint8Array(32),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      },
    });
    return 'none';
  } catch (e) {
    return (e as DOMException).name;
  }
}

test('a create, then a get signed by the stored passkey, each confirmed in the window', async ({
  context,
  extensionId,
}) => {
  test.setTimeout(120_000);
  await host(context, extensionId);
  const page = await site(context);

  let window = nextWindow(context);
  const creating = page.evaluate(create);
  let confirm = await window;
  await expect(confirm.getByTestId('confirm-origin')).toHaveText(SITE);
  await expect(confirm.getByText('ana@site.test')).toBeVisible();
  await confirm.getByTestId('confirm-save').click();
  const created = await creating;
  expect(created.instance).toBe(true);
  expect(created.extensions).toEqual({ credProps: { rk: true } });
  expect(created.json).toMatchObject({ type: 'public-key', authenticatorAttachment: 'platform' });
  expect(created.json.response.transports).toEqual(['internal', 'hybrid']);
  expect(JSON.parse(decode(created.json.response.clientDataJSON).toString())).toEqual({
    type: 'webauthn.create',
    challenge: Buffer.alloc(32, 1).toString('base64url'),
    origin: SITE,
    crossOrigin: false,
  });
  await expect(
    confirm.isClosed() ? Promise.resolve() : confirm.waitForEvent('close'),
  ).resolves.toBe(undefined);

  window = nextWindow(context);
  const getting = page.evaluate(async () => {
    const c = (await navigator.credentials.get({
      publicKey: { challenge: new Uint8Array(32).fill(2), rpId: 'site.test' },
    })) as PublicKeyCredential;
    return { instance: c instanceof PublicKeyCredential, json: c.toJSON() as unknown as Json };
  });
  confirm = await window;
  await expect(confirm.getByText('ana@site.test')).toBeVisible();
  await confirm.getByTestId('confirm-use').click();
  const asserted = await getting;
  expect(asserted.instance).toBe(true);
  expect(asserted.json.id).toBe(created.json.id);
  const { clientDataJSON, authenticatorData, signature, userHandle } = asserted.json.response;
  expect(JSON.parse(decode(clientDataJSON).toString())).toMatchObject({
    type: 'webauthn.get',
    origin: SITE,
    crossOrigin: false,
  });
  expect(decode(userHandle)).toEqual(Buffer.from([1, 2, 3]));
  const data = decode(authenticatorData);
  expect(data.subarray(0, 32)).toEqual(createHash('sha256').update('site.test').digest());
  // UP, UV, BE and BS (§7.3), and signCount 0.
  expect(data[32]).toBe(0x1d);
  expect(data.readUInt32BE(33)).toBe(0);
  const signed = Buffer.concat([
    data,
    createHash('sha256').update(decode(clientDataJSON)).digest(),
  ]);
  const key = {
    key: decode(created.json.response.publicKey),
    format: 'der',
    type: 'spki',
  } as const;
  expect(verify('sha256', signed, key, decode(signature))).toBe(true);
});

test('a cross-origin frame’s request names its top origin, and Cancel answers NotAllowedError', async ({
  context,
  extensionId,
}) => {
  test.setTimeout(120_000);
  await host(context, extensionId);
  const page = await site(context);
  const frame = page.frames().find((f) => f.url().startsWith(ADS));
  if (!frame) throw new Error('no frame');

  let window = nextWindow(context);
  const creating = frame.evaluate(create);
  let confirm = await window;
  await expect(confirm.getByTestId('confirm-origin')).toHaveText(ADS);
  await expect(confirm.getByText(SITE)).toBeVisible();
  await confirm.getByTestId('confirm-save').click();
  const { json } = await creating;
  expect(JSON.parse(decode(json.response.clientDataJSON).toString())).toEqual({
    type: 'webauthn.create',
    challenge: Buffer.alloc(32, 1).toString('base64url'),
    origin: ADS,
    crossOrigin: true,
    topOrigin: SITE,
  });

  window = nextWindow(context);
  const cancelled = page.evaluate(failedCreate);
  confirm = await window;
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(cancelled).resolves.toBe('NotAllowedError');
});

test('a second request while one waits is refused, and a lock closes the window', async ({
  context,
  worker,
  extensionId,
}) => {
  test.setTimeout(120_000);
  await host(context, extensionId);
  const page = await site(context);
  const frame = page.frames().find((f) => f.url().startsWith(ADS));
  if (!frame) throw new Error('no frame');

  const window = nextWindow(context);
  const waiting = page.evaluate(failedCreate);
  const confirm = await window;
  await expect(frame.evaluate(failedCreate)).resolves.toBe('NotAllowedError');
  await expect(confirm.getByTestId('confirm-save')).toBeVisible();

  const closed = confirm.waitForEvent('close');
  await worker.evaluate(() =>
    (
      globalThis as unknown as { chrome: { runtime: { sendMessage(m: object): Promise<unknown> } } }
    ).chrome.runtime.sendMessage({ v: 1, type: 'lock', id: 0 }),
  );
  await closed;
  await expect(waiting).resolves.toBe('NotAllowedError');
});
