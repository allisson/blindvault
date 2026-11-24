import { createPasskey, initCrypto } from '@blindvault/crypto';
import {
  type Field,
  type Item,
  type ItemInput,
  type ItemView,
  type PasskeyValue,
  type VaultSession,
} from '@blindvault/vault';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { fromBase64url, toBase64url } from '../extension/passkey-options';
import { type ProviderResult } from '../platform/android-provider';
import { hex } from './ids';
import { type Binding, type ProviderApp, ProviderFlow } from './provider-flow';

beforeAll(initCrypto);
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const ORIGIN = 'https://login.example.com';
const HASH = Uint8Array.from({ length: 32 }, (_, i) => 100 + i);
const CHALLENGE = toBase64url(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const USER = Uint8Array.of(7, 7, 7);
const BROWSER = { kind: 'browser', origin: ORIGIN, packageName: 'com.android.chrome' };

function answer(
  kind: 'get' | 'create',
  options: Record<string, unknown>,
  caller: unknown = BROWSER,
) {
  return {
    v: 1,
    id: 1,
    ok: true,
    kind,
    caller,
    requestJson: JSON.stringify(options),
    clientDataHash: toBase64url(HASH),
  };
}

const GET = { challenge: CHALLENGE, rpId: 'example.com', userVerification: 'required' };
const CREATE = {
  rp: { id: 'example.com', name: 'Example' },
  user: { id: toBase64url(USER), name: 'ana@example.com', displayName: 'Ana' },
  challenge: CHALLENGE,
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  attestation: 'none',
};

const id = (n: number) => Uint8Array.from({ length: 16 }, (_, i) => (i === 15 ? n : 0));

function view(n: number, item: Item): ItemView {
  return { id: id(n), hlc: {} as never, inTrash: false, item };
}

function login(title: string, fields: Field[]): Item {
  return { templateId: 'login', templateVersion: 1, title, fields, tags: [] };
}

async function stored(rpId: string) {
  const created = await createPasskey(rpId, 'EdDSA');
  const value: PasskeyValue = {
    privateKey: created.privateKey,
    credentialId: Uint8Array.of(5),
    rpId,
    userHandle: USER,
    userName: 'ana',
    createdAt: 0,
  };
  return { value, publicKey: created.publicKey };
}

/** A flow over a fake shell and a fake app window holding one session. */
function harness(
  request: unknown,
  options: {
    status?: string;
    writable?: boolean;
    items?: ItemView[];
    /** The shell's `provider-assetlinks` answer per domain; `unbound` for any other. */
    bindings?: Record<string, Binding>;
  } = {},
) {
  let items = options.items ?? [];
  const session = {
    items: () => items,
    writable: options.writable ?? true,
    createItem: vi.fn((input: ItemInput) => {
      items = [...items, view(90, input)];
      return Promise.resolve(id(90));
    }),
    updateItem: vi.fn(() => Promise.resolve(true)),
  } as unknown as VaultSession;
  const statusOf = (kind: string) => (kind === 'unlocked' ? { kind, session } : { kind });
  let status: { kind: string; session?: VaultSession } = statusOf(options.status ?? 'locked');
  const listeners = new Set<() => void>();
  const set = (kind: string) => {
    status = statusOf(kind);
    for (const l of listeners) l();
  };
  const takeOver = vi.fn(() => {
    set('locked');
    return Promise.resolve();
  });
  const lock = vi.fn(() => {
    if (status.kind === 'unlocked') set('locked');
  });
  const app: ProviderApp = {
    get status() {
      return status;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    takeOver,
    lock,
  };
  const results: ProviderResult[] = [];
  const assetlinks = vi.fn((domain: string) =>
    Promise.resolve(options.bindings?.[domain] ?? ('unbound' as const)),
  );
  const flow = new ProviderFlow({
    app,
    shell: {
      request: () =>
        request instanceof Error ? Promise.reject(request) : Promise.resolve(request as never),
      assetlinks,
      result: (r) => results.push(r),
    },
    now: () => 1_790_000_000_000,
  });
  return { flow, takeOver, lock, session, set, results, assetlinks, items: () => items };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

/** The fake session's `createItem` mock. */
const createItemOf = (session: VaultSession) =>
  (session as unknown as { createItem: ReturnType<typeof vi.fn> }).createItem;

describe('ProviderFlow: the request (android.md §7.1, §7.7, D301)', () => {
  it('ends with NotAllowedError when the shell’s request is malformed or refused', async () => {
    for (const request of [{ v: 1, id: 1, ok: true }, new Error('invalid')]) {
      const h = harness(request);
      void h.flow.start();
      await settle();
      expect(h.results).toEqual([{ kind: 'error', name: 'NotAllowedError' }]);
      expect(h.flow.getState().kind).toBe('ended');
    }
  });

  it('ends with NotAllowedError when the rpId is not the origin’s site (CRYPTO-INV-029)', async () => {
    for (const rpId of ['other.com', 'com']) {
      const h = harness(answer('get', { ...GET, rpId }));
      void h.flow.start();
      await settle();
      expect(h.results).toEqual([{ kind: 'error', name: 'NotAllowedError' }]);
    }
  });

  it('takes the vault over from the main window once, which the user’s choice of BlindVault allows', async () => {
    const h = harness(answer('get', GET), { status: 'elsewhere' });
    void h.flow.start();
    await settle();
    expect(h.takeOver).toHaveBeenCalledTimes(1);
    expect(h.flow.getState().kind).toBe('unlock');
    // Taken back by the main window: the request ends.
    h.set('elsewhere');
    await settle();
    expect(h.takeOver).toHaveBeenCalledTimes(1);
    expect(h.results).toEqual([{ kind: 'cancelled' }]);
  });

  it('asks for the unlock, and shows the request once unlocked', async () => {
    const h = harness(answer('get', GET));
    void h.flow.start();
    await settle();
    expect(h.flow.getState().kind).toBe('unlock');
    h.set('unlocked');
    expect(h.flow.getState()).toMatchObject({
      kind: 'confirm',
      state: { kind: 'get', origin: ORIGIN, rpId: 'example.com', passkeys: [] },
    });
    expect(h.results).toEqual([]);
  });

  it('says there is no vault, and ends only on the user’s cancel', async () => {
    const h = harness(answer('get', GET), { status: 'no-vault' });
    void h.flow.start();
    await settle();
    expect(h.flow.getState().kind).toBe('no-vault');
    expect(h.results).toEqual([]);
    h.flow.choose({ choice: 'cancel' });
    expect(h.results).toEqual([{ kind: 'cancelled' }]);
  });
});

describe('ProviderFlow: get (android.md §7.5, CRYPTO-INV-029)', () => {
  it('signs over the browser’s clientDataHash after the tap, leaves clientDataJSON out, and locks', async () => {
    const { value, publicKey } = await stored('example.com');
    const items = [view(1, login('Example', [{ type: 'passkey', value }]))];
    const h = harness(answer('get', GET), { status: 'unlocked', items });
    void h.flow.start();
    await settle();
    const state = h.flow.getState();
    if (state.kind !== 'confirm' || state.state.kind !== 'get') throw new Error('no get');
    expect(state.state.passkeys.map((p) => p.credentialId)).toEqual([hex(Uint8Array.of(5))]);
    expect(h.results).toEqual([]);

    h.flow.choose({ choice: 'use', credentialId: hex(Uint8Array.of(5)) });
    await settle();
    const [result] = h.results;
    if (result?.kind !== 'asserted') throw new Error(`not asserted: ${JSON.stringify(result)}`);
    expect(result).not.toHaveProperty('clientDataJSON');
    const data = fromBase64url(result.authenticatorData);
    const signature = fromBase64url(result.signature);
    if (!data || !signature) throw new Error('not base64url');
    const key = await crypto.subtle.importKey('spki', new Uint8Array(publicKey), 'Ed25519', false, [
      'verify',
    ]);
    const signed = new Uint8Array([...data, ...HASH]);
    expect(await crypto.subtle.verify('Ed25519', key, new Uint8Array(signature), signed)).toBe(
      true,
    );
    expect(result.userHandle).toBe(toBase64url(USER));
    expect(h.lock).toHaveBeenCalled();
    expect(h.flow.getState().kind).toBe('ended');
  });

  it('refuses a passkey it did not list and stays open', async () => {
    const h = harness(answer('get', GET), { status: 'unlocked' });
    void h.flow.start();
    await settle();
    h.flow.choose({ choice: 'use', credentialId: hex(Uint8Array.of(9)) });
    await settle();
    expect(h.results).toEqual([]);
    expect(h.flow.getState()).toMatchObject({ kind: 'confirm', note: 'not-found' });
  });
});

describe('ProviderFlow: create (android.md §7.5)', () => {
  it('saves a new Login item after the tap, and answers without clientDataJSON', async () => {
    const h = harness(answer('create', CREATE), { status: 'unlocked' });
    void h.flow.start();
    await settle();
    expect(createItemOf(h.session)).not.toHaveBeenCalled();
    h.flow.choose({ choice: 'save-new' });
    // Generating the ES256 key is WebCrypto's own work, outside the fake timers.
    vi.useRealTimers();
    await vi.waitFor(() => {
      expect(h.results).toHaveLength(1);
    });
    expect(createItemOf(h.session)).toHaveBeenCalledTimes(1);
    const [result] = h.results;
    expect(result).toMatchObject({ kind: 'created', publicKeyAlgorithm: -7 });
    expect(result).not.toHaveProperty('clientDataJSON');
  });

  it('answers NotAllowedError to a create on a read-only vault (D73)', async () => {
    const h = harness(answer('create', CREATE), { status: 'unlocked', writable: false });
    void h.flow.start();
    await settle();
    expect(h.results).toEqual([{ kind: 'error', name: 'NotAllowedError' }]);
    expect(createItemOf(h.session)).not.toHaveBeenCalled();
  });

  it('refuses a get choice for a create', async () => {
    const h = harness(answer('create', CREATE), { status: 'unlocked' });
    void h.flow.start();
    await settle();
    h.flow.choose({ choice: 'use', credentialId: '05' });
    await settle();
    expect(h.results).toEqual([]);
    expect(h.flow.getState()).toMatchObject({ kind: 'confirm', note: 'invalid' });
  });
});

describe('ProviderFlow: ending (android.md §7.1 Ending, D301)', () => {
  it('ends with a cancellation on Cancel, and goes back to the sheet on another authenticator', async () => {
    const cancel = harness(answer('get', GET), { status: 'unlocked' });
    void cancel.flow.start();
    await settle();
    cancel.flow.choose({ choice: 'cancel' });
    expect(cancel.results).toEqual([{ kind: 'cancelled' }]);

    const browser = harness(answer('get', GET), { status: 'unlocked' });
    void browser.flow.start();
    await settle();
    browser.flow.choose({ choice: 'browser' });
    expect(browser.results).toEqual([{ kind: 'browser' }]);
    expect(browser.lock).toHaveBeenCalled();
  });

  it('ends with a cancellation when the vault locks', async () => {
    const h = harness(answer('get', GET), { status: 'unlocked' });
    void h.flow.start();
    await settle();
    h.set('locked');
    expect(h.results).toEqual([{ kind: 'cancelled' }]);
  });

  it('ends with a cancellation once the request’s time elapses, bounded to 30 s to 600 s', async () => {
    const h = harness(answer('get', { ...GET, timeout: 1000 }), { status: 'unlocked' });
    void h.flow.start();
    await settle();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.results).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.results).toEqual([{ kind: 'cancelled' }]);
  });

  it('answers once: a later choice, lock or timeout sends nothing', async () => {
    const h = harness(answer('get', GET), { status: 'unlocked' });
    void h.flow.start();
    await settle();
    h.flow.choose({ choice: 'cancel' });
    h.flow.choose({ choice: 'browser' });
    h.set('locked');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.results).toEqual([{ kind: 'cancelled' }]);
  });

  it('ends with a cancellation when the window is told to end (screen off, Back)', async () => {
    const h = harness(answer('get', GET), { status: 'unlocked' });
    void h.flow.start();
    await settle();
    h.flow.end();
    expect(h.results).toEqual([{ kind: 'cancelled' }]);
    expect(h.lock).toHaveBeenCalled();
  });
});

const CERT = 'cd'.repeat(32);
const APP = { kind: 'app', packageName: 'com.example.app', certSha256: [CERT] };
const APP_ORIGIN = `android:apk-key-hash:${toBase64url(new Uint8Array(32).fill(0xcd))}`;

function appAnswer(kind: 'get' | 'create', options: Record<string, unknown>) {
  return { v: 1, id: 1, ok: true, kind, caller: APP, requestJson: JSON.stringify(options) };
}

function passwordAnswer(caller: unknown) {
  return { v: 1, id: 1, ok: true, kind: 'password', caller };
}

/** An app's result's `clientDataJSON`, or a failed test. */
function clientDataOf(result: ProviderResult | undefined): string {
  const value = result && 'clientDataJSON' in result ? result.clientDataJSON : undefined;
  if (typeof value !== 'string') throw new Error(`no clientDataJSON: ${JSON.stringify(result)}`);
  return value;
}

const decode = (text: string) => {
  const bytes = fromBase64url(text);
  if (!bytes) throw new Error('not base64url');
  return bytes;
};

describe('ProviderFlow: an app’s passkey (android.md §7.4, §7.5, D303, CRYPTO-INV-029)', () => {
  it('checks the rpId’s assetlinks.json before the unlock, and takes nothing over until it binds', async () => {
    const h = harness(appAnswer('get', GET), { status: 'elsewhere' });
    void h.flow.start();
    await settle();
    expect(h.assetlinks.mock.calls).toEqual([['example.com']]);
    expect(h.flow.getState()).toMatchObject({
      kind: 'unbound',
      packageName: 'com.example.app',
      unbound: { domains: ['example.com'], binding: 'unbound' },
    });
    expect(h.takeOver).not.toHaveBeenCalled();
    expect(h.results).toEqual([]);
    h.flow.choose({ choice: 'cancel' });
    expect(h.results).toEqual([{ kind: 'cancelled' }]);
  });

  it('says why: a redirect, the network', async () => {
    for (const binding of ['redirect', 'network'] as const) {
      const h = harness(appAnswer('get', GET), { bindings: { 'example.com': binding } });
      void h.flow.start();
      await settle();
      expect(h.flow.getState()).toMatchObject({ kind: 'unbound', unbound: { binding } });
    }
  });

  it('signs a bound app’s get over its own clientDataJSON, at android:apk-key-hash', async () => {
    const { value, publicKey } = await stored('example.com');
    const items = [view(1, login('Example', [{ type: 'passkey', value }]))];
    const h = harness(appAnswer('get', GET), {
      items,
      bindings: { 'example.com': 'bound' },
    });
    void h.flow.start();
    await settle();
    expect(h.flow.getState().kind).toBe('unlock');
    h.set('unlocked');
    expect(h.flow.getState()).toMatchObject({
      kind: 'confirm',
      app: 'com.example.app',
      state: { kind: 'get', rpId: 'example.com' },
    });
    h.flow.choose({ choice: 'use', credentialId: hex(Uint8Array.of(5)) });
    await settle();
    const [result] = h.results;
    if (result?.kind !== 'asserted') throw new Error(`not asserted: ${JSON.stringify(result)}`);
    const clientData = decode(clientDataOf(result));
    expect(JSON.parse(new TextDecoder().decode(clientData))).toEqual({
      type: 'webauthn.get',
      challenge: CHALLENGE,
      origin: APP_ORIGIN,
      crossOrigin: false,
    });
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(clientData)));
    const key = await crypto.subtle.importKey('spki', new Uint8Array(publicKey), 'Ed25519', false, [
      'verify',
    ]);
    const signed = new Uint8Array([...decode(result.authenticatorData), ...hash]);
    expect(
      await crypto.subtle.verify('Ed25519', key, new Uint8Array(decode(result.signature)), signed),
    ).toBe(true);
  });

  it('saves a bound app’s create, with clientDataJSON at android:apk-key-hash', async () => {
    const h = harness(appAnswer('create', CREATE), {
      status: 'unlocked',
      bindings: { 'example.com': 'bound' },
    });
    void h.flow.start();
    await settle();
    h.flow.choose({ choice: 'save-new' });
    vi.useRealTimers();
    await vi.waitFor(() => {
      expect(h.results).toHaveLength(1);
    });
    const [result] = h.results;
    expect(result?.kind).toBe('created');
    expect(JSON.parse(new TextDecoder().decode(decode(clientDataOf(result))))).toMatchObject({
      type: 'webauthn.create',
      origin: APP_ORIGIN,
    });
  });

  it('ends with NotAllowedError, asking nothing, when an app’s rpId is not a registrable domain', async () => {
    const h = harness(appAnswer('get', { ...GET, rpId: 'com' }));
    void h.flow.start();
    await settle();
    expect(h.assetlinks).not.toHaveBeenCalled();
    expect(h.results).toEqual([{ kind: 'error', name: 'NotAllowedError' }]);
  });
});

const PASSWORD_ITEMS = () => [
  view(
    1,
    login('Example', [
      { type: 'text', role: 'username', value: 'ana' },
      { type: 'secret', role: 'password', value: 'pw-1' },
      { type: 'url', role: 'url', value: 'https://login.example.com' },
    ]),
  ),
  view(
    2,
    login('No password', [
      { type: 'text', role: 'username', value: 'bia' },
      { type: 'url', role: 'url', value: 'https://login.example.com' },
    ]),
  ),
  view(
    3,
    login('Other', [
      { type: 'text', role: 'username', value: 'caio' },
      { type: 'secret', role: 'password', value: 'pw-3' },
      { type: 'url', role: 'url', value: 'http://insecure.example.net' },
      { type: 'url', role: 'url', value: '10.0.0.1' },
      { type: 'url', role: 'url', value: 'https://www.example.net/login' },
      { type: 'url', role: 'url', value: 'https://app.example.net' },
    ]),
  ),
];

describe('ProviderFlow: a password (android.md §7.6, D303, CRYPTO-INV-029)', () => {
  it('lists a browser’s logins of its origin, with a user name and a password, and hands one over on the tap', async () => {
    const h = harness(passwordAnswer(BROWSER), { status: 'unlocked', items: PASSWORD_ITEMS() });
    void h.flow.start();
    await settle();
    expect(h.flow.getState()).toMatchObject({
      kind: 'password',
      logins: [{ itemId: hex(id(1)), title: 'Example', userName: 'ana' }],
    });
    expect(h.results).toEqual([]);
    await h.flow.pick(hex(id(1)));
    expect(h.results).toEqual([{ kind: 'password', userName: 'ana', password: 'pw-1' }]);
    expect(h.assetlinks).not.toHaveBeenCalled();
    expect(h.lock).toHaveBeenCalled();
  });

  it('refuses a login the window did not list', async () => {
    const h = harness(passwordAnswer(BROWSER), { status: 'unlocked', items: PASSWORD_ITEMS() });
    void h.flow.start();
    await settle();
    for (const n of [2, 3, 9]) await h.flow.pick(hex(id(n)));
    expect(h.results).toEqual([]);
    expect(h.flow.getState()).toMatchObject({ kind: 'password', note: 'not-found' });
  });

  it('searches for an app, and hands a login over only when the host of one of its https URLs binds it', async () => {
    const h = harness(passwordAnswer(APP), {
      status: 'unlocked',
      items: PASSWORD_ITEMS(),
      bindings: { 'app.example.net': 'bound' },
    });
    void h.flow.start();
    await settle();
    expect(h.flow.getState()).toMatchObject({ kind: 'password', query: '' });
    h.flow.search('other');
    expect(h.flow.getState()).toMatchObject({
      kind: 'password',
      query: 'other',
      logins: [{ itemId: hex(id(3)), userName: 'caio' }],
    });
    await h.flow.pick(hex(id(3)));
    // The exact hosts, in order; no http URL, no IP address, never the registrable domain.
    expect(h.assetlinks.mock.calls).toEqual([['www.example.net'], ['app.example.net']]);
    expect(h.results).toEqual([{ kind: 'password', userName: 'caio', password: 'pw-3' }]);
  });

  it('hands nothing to an app no host binds, and says which hosts it asked', async () => {
    const h = harness(passwordAnswer(APP), {
      status: 'unlocked',
      items: PASSWORD_ITEMS(),
      bindings: { 'login.example.com': 'redirect' },
    });
    void h.flow.start();
    await settle();
    await h.flow.pick(hex(id(1)));
    expect(h.results).toEqual([]);
    expect(h.flow.getState()).toMatchObject({
      kind: 'password',
      busy: false,
      note: { domains: ['login.example.com'], binding: 'redirect' },
    });
  });

  it('asks the unlock first, and ends with a cancellation after 300 s', async () => {
    const h = harness(passwordAnswer(APP), { items: PASSWORD_ITEMS() });
    void h.flow.start();
    await settle();
    expect(h.flow.getState().kind).toBe('unlock');
    expect(h.assetlinks).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(299_999);
    expect(h.results).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.results).toEqual([{ kind: 'cancelled' }]);
  });
});
