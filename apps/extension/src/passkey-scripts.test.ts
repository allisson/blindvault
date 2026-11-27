import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

// The content scripts are classic scripts: each runs here against a window of its own.
const MAIN = readFileSync(new URL('passkey-main.js', import.meta.url), 'utf8');
const ISOLATED = readFileSync(new URL('passkey-isolated.js', import.meta.url), 'utf8');

type Data = Record<string, unknown>;

class PublicKeyCredential {
  readonly fake = true;
}
class AuthenticatorAttestationResponse {
  readonly fake = true;
}
class AuthenticatorAssertionResponse {
  readonly fake = true;
}

/** A window whose messages arrive as a browser delivers them: later, cloned, from the window. */
function fakeWindow(credentials: object) {
  const target = new EventTarget();
  const posted: Data[] = [];
  const win = {
    navigator: { credentials },
    crypto: globalThis.crypto,
    setTimeout: (f: () => void, ms: number) => globalThis.setTimeout(f, ms),
    clearTimeout: (t: number) => {
      globalThis.clearTimeout(t);
    },
    PublicKeyCredential,
    AuthenticatorAttestationResponse,
    AuthenticatorAssertionResponse,
    addEventListener: target.addEventListener.bind(target),
    postMessage: (data: Data) => {
      posted.push(data);
      const copy = structuredClone(data);
      queueMicrotask(() => {
        target.dispatchEvent(Object.assign(new Event('message'), { source: win, data: copy }));
      });
    },
    /** A message from another window, which the scripts must not take. */
    foreign: (data: Data) => {
      target.dispatchEvent(Object.assign(new Event('message'), { source: {}, data }));
    },
  };
  return { win, posted };
}

const NATIVE = { native: true };

function main() {
  const credentials = {
    create: vi.fn<(options?: unknown) => Promise<unknown>>(() => Promise.resolve(NATIVE)),
    get: vi.fn<(options?: unknown) => Promise<unknown>>(() => Promise.resolve(NATIVE)),
  };
  const { win, posted } = fakeWindow(credentials);
  const original = { create: credentials.create, get: credentials.get };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the shipped script, run as the browser runs it.
  (new Function('window', MAIN) as (w: unknown) => void)(win);
  const nav = win.navigator.credentials as unknown as {
    create(o?: unknown): Promise<unknown>;
    get(o?: unknown): Promise<unknown>;
  };
  /** The request the MAIN-world script sent to the isolated script. */
  const sent = async () => {
    await vi.waitFor(() => {
      expect(posted.some((p) => p.to === 'isolated')).toBe(true);
    });
    return posted.find((p) => p.to === 'isolated') as Data & { request: string; options: Data };
  };
  const answer = (request: string, result: unknown) => {
    win.postMessage({ channel: 'blindvault-passkey', to: 'main', request, result });
  };
  return { nav, original, sent, answer, win, posted };
}

const bytes = (...b: number[]) => new Uint8Array(b);
const CHALLENGE = new Uint8Array(16).fill(7);
const B64_CHALLENGE = 'BwcHBwcHBwcHBwcHBwcHBw';

const CREATE = {
  publicKey: {
    rp: { id: 'site.example', name: 'Site' },
    user: { id: bytes(1, 2, 3), name: 'ana', displayName: 'Ana' },
    challenge: CHALLENGE.buffer,
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    timeout: 60_000,
    excludeCredentials: [{ type: 'public-key', id: bytes(9), transports: ['usb'] }],
    authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required' },
    attestation: 'direct',
    hints: ['client-device'],
    extensions: { credProps: true, prf: { eval: { first: bytes(1) } } },
  },
};

const CREATED = {
  kind: 'created',
  id: 'AQID',
  clientDataJSON: 'e30',
  attestationObject: 'oA',
  authenticatorData: 'AAAA',
  publicKey: 'MFk',
  publicKeyAlgorithm: -7,
};

const ASSERTED = {
  kind: 'asserted',
  id: 'AQID',
  clientDataJSON: 'e30',
  authenticatorData: 'AAAA',
  signature: 'MEU',
  userHandle: 'AQID',
};

afterEach(() => {
  vi.useRealTimers();
});

describe('the MAIN-world script (extension.md §7.2, §7.7)', () => {
  it('copies only the keys of §7.7, bytes as base64url, under a request ID of its own', async () => {
    const { nav, sent } = main();
    void nav.create(CREATE);
    const message = await sent();
    expect(message).toEqual({
      channel: 'blindvault-passkey',
      to: 'isolated',
      type: 'passkey-create',
      request: expect.stringMatching(/^[0-9a-f]{32}$/) as unknown,
      options: {
        rp: { id: 'site.example', name: 'Site' },
        user: { id: 'AQID', name: 'ana', displayName: 'Ana' },
        challenge: B64_CHALLENGE,
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        timeout: 60_000,
        excludeCredentials: [{ type: 'public-key', id: 'CQ' }],
        authenticatorSelection: { authenticatorAttachment: 'platform' },
        extensions: { credProps: true },
      },
    });
  });

  it('copies a get', async () => {
    const { nav, sent } = main();
    void nav.get({
      publicKey: {
        challenge: CHALLENGE,
        rpId: 'site.example',
        allowCredentials: [{ type: 'public-key', id: bytes(9).buffer }],
        userVerification: 'required',
      },
    });
    const message = await sent();
    expect(message.type).toBe('passkey-get');
    expect(message.options).toEqual({
      challenge: B64_CHALLENGE,
      rpId: 'site.example',
      allowCredentials: [{ type: 'public-key', id: 'CQ' }],
    });
  });

  it.each([
    ['no publicKey', { password: true }],
    ['conditional mediation', { mediation: 'conditional', publicKey: { challenge: CHALLENGE } }],
    ['a challenge that is not bytes', { publicKey: { challenge: 'abc' } }],
    ['no options', undefined],
  ])('hands %s to the browser at once', async (_name, options) => {
    const { nav, original } = main();
    await expect(nav.get(options)).resolves.toBe(NATIVE);
    expect(original.get).toHaveBeenCalledWith(options);
  });

  it('builds the credential of a create, as the spike measured', async () => {
    const { nav, sent, answer } = main();
    const call = nav.create(CREATE);
    answer((await sent()).request, CREATED);
    const c = (await call) as Record<string, unknown> & {
      response: Record<string, unknown> & {
        getTransports(): string[];
        getPublicKeyAlgorithm(): number;
        getAuthenticatorData(): ArrayBuffer;
      };
      getClientExtensionResults(): unknown;
      toJSON(): Record<string, unknown>;
    };
    expect(c).toBeInstanceOf(PublicKeyCredential);
    expect(c.response).toBeInstanceOf(AuthenticatorAttestationResponse);
    expect(c.id).toBe('AQID');
    expect(new Uint8Array(c.rawId as ArrayBuffer)).toEqual(bytes(1, 2, 3));
    expect(c.type).toBe('public-key');
    expect(c.authenticatorAttachment).toBe('platform');
    expect(c.getClientExtensionResults()).toEqual({ credProps: { rk: true } });
    expect(c.response.getTransports()).toEqual(['internal', 'hybrid']);
    expect(c.response.getPublicKeyAlgorithm()).toBe(-7);
    expect(new Uint8Array(c.response.getAuthenticatorData())).toEqual(bytes(0, 0, 0));
    expect(Object.keys(c.toJSON()).sort()).toEqual([
      'authenticatorAttachment',
      'clientExtensionResults',
      'id',
      'rawId',
      'response',
      'type',
    ]);
    expect(c.toJSON().response).toEqual({
      clientDataJSON: 'e30',
      authenticatorData: 'AAAA',
      transports: ['internal', 'hybrid'],
      publicKey: 'MFk',
      publicKeyAlgorithm: -7,
      attestationObject: 'oA',
    });
  });

  it('answers no extension the page did not ask for, prf included', async () => {
    const { nav, sent, answer } = main();
    const call = nav.create({
      publicKey: { ...CREATE.publicKey, extensions: { prf: { eval: { first: bytes(1) } } } },
    });
    answer((await sent()).request, CREATED);
    const c = (await call) as { getClientExtensionResults(): unknown };
    expect(c.getClientExtensionResults()).toEqual({});
  });

  it('builds the credential of a get', async () => {
    const { nav, sent, answer } = main();
    const call = nav.get({ publicKey: { challenge: CHALLENGE } });
    answer((await sent()).request, ASSERTED);
    const c = (await call) as { response: Record<string, unknown>; toJSON(): Data };
    expect(c).toBeInstanceOf(PublicKeyCredential);
    expect(c.response).toBeInstanceOf(AuthenticatorAssertionResponse);
    expect(new Uint8Array(c.response.userHandle as ArrayBuffer)).toEqual(bytes(1, 2, 3));
    expect(c.toJSON().response).toEqual({
      clientDataJSON: 'e30',
      authenticatorData: 'AAAA',
      signature: 'MEU',
      userHandle: 'AQID',
    });
  });

  it('calls the browser with the page’s options when handed back', async () => {
    const { nav, sent, answer, original } = main();
    const call = nav.create(CREATE);
    answer((await sent()).request, { kind: 'browser' });
    await expect(call).resolves.toBe(NATIVE);
    expect(original.create).toHaveBeenCalledWith(CREATE);
  });

  it.each([
    ['InvalidStateError', { kind: 'error', name: 'InvalidStateError' }],
    ['NotAllowedError', { kind: 'error', name: 'NotAllowedError' }],
    ['NotAllowedError', { kind: 'error', name: 'SecurityError' }],
    ['NotAllowedError', ASSERTED],
    ['NotAllowedError', { ...CREATED, publicKey: 'not base64url!' }],
    ['NotAllowedError', { ...CREATED, publicKeyAlgorithm: '-7' }],
    ['NotAllowedError', 'created'],
  ])('rejects with %s on %j', async (name, result) => {
    const { nav, sent, answer } = main();
    const call = nav.create(CREATE);
    answer((await sent()).request, result);
    await expect(call).rejects.toMatchObject({ name });
  });

  it('ignores an answer to another request and one from another window', async () => {
    const { nav, sent, answer, win } = main();
    let settled = false;
    const call = nav.get({ publicKey: { challenge: CHALLENGE } }).finally(() => {
      settled = true;
    });
    const { request } = await sent();
    answer('f'.repeat(32), ASSERTED);
    win.foreign({ channel: 'blindvault-passkey', to: 'main', request, result: ASSERTED });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    answer(request, { kind: 'error', name: 'NotAllowedError' });
    await expect(call).rejects.toMatchObject({ name: 'NotAllowedError' });
  });

  it('rejects with the signal’s reason when the page aborts, and ends the request (P-03)', async () => {
    const { nav, sent, answer, posted } = main();
    const controller = new AbortController();
    const call = nav.get({ publicKey: { challenge: CHALLENGE }, signal: controller.signal });
    const { request } = await sent();
    controller.abort(new DOMException('stop', 'AbortError'));
    await expect(call).rejects.toMatchObject({ name: 'AbortError' });
    expect(posted.at(-1)).toEqual({
      channel: 'blindvault-passkey',
      to: 'isolated',
      type: 'passkey-cancel',
      request,
    });
    answer(request, ASSERTED);
    const aborted = new AbortController();
    aborted.abort(new DOMException('before', 'AbortError'));
    await expect(
      nav.get({ publicKey: { challenge: CHALLENGE }, signal: aborted.signal }),
    ).rejects.toMatchObject({ message: 'before' });
  });

  it('ends a call whose answer never comes after the bounded timeout', async () => {
    vi.useFakeTimers();
    const { nav, sent } = main();
    const call = nav.get({ publicKey: { challenge: CHALLENGE, timeout: 1 } });
    const outcome = call.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    await sent();
    // 30 s, the shortest the session host waits, and 5 s more.
    await vi.advanceTimersByTimeAsync(34_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(outcome).resolves.toMatchObject({ name: 'NotAllowedError' });
  });
});

function isolated() {
  const { win, posted } = fakeWindow({});
  const listeners: ((message: unknown, sender: object) => boolean)[] = [];
  const runtime = {
    id: 'abc',
    sendMessage: vi.fn<(m: unknown) => Promise<unknown>>(() =>
      Promise.resolve({ v: 1, id: 0, ok: true }),
    ),
    onMessage: {
      addListener: (l: (message: unknown, sender: object) => boolean) => listeners.push(l),
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the shipped script, run as the browser runs it.
  (new Function('window', 'globalThis', ISOLATED) as (w: unknown, g: unknown) => void)(win, {
    chrome: { runtime },
  });
  const deliver = (message: unknown, sender: object) => listeners.map((l) => l(message, sender));
  const toMain = () => posted.filter((p) => p.to === 'main');
  return { win, runtime, deliver, toMain };
}

const REQUEST = '0123456789abcdef0123456789abcdef';
const FROM_MAIN = {
  channel: 'blindvault-passkey',
  to: 'isolated',
  type: 'passkey-get',
  request: REQUEST,
  options: { challenge: B64_CHALLENGE },
};
const WORKER = { id: 'abc', url: 'chrome-extension://abc/background.js' };
const ANSWER = { v: 1, type: 'passkey-answer', id: 0, request: REQUEST, result: ASSERTED };

describe('the isolated content script (extension.md §7.7)', () => {
  it('carries the request to the service worker, with no origin of its own', async () => {
    const { win, runtime } = isolated();
    win.postMessage(FROM_MAIN);
    await vi.waitFor(() => {
      expect(runtime.sendMessage).toHaveBeenCalledWith({
        v: 1,
        type: 'passkey-get',
        id: 0,
        request: REQUEST,
        options: { challenge: B64_CHALLENGE },
      });
    });
  });

  it.each([
    ['a refusal', () => Promise.resolve({ v: 1, id: 0, ok: false, error: 'invalid' })],
    ['no answer', () => Promise.reject(new Error('Receiving end does not exist.'))],
    ['an answer to another message', () => Promise.resolve({ v: 1, id: 5, ok: true })],
  ])('hands the call to the browser on %s', async (_name, reply) => {
    const { win, runtime, toMain } = isolated();
    runtime.sendMessage.mockImplementation(reply);
    win.postMessage(FROM_MAIN);
    await vi.waitFor(() => {
      expect(toMain()).toEqual([
        {
          channel: 'blindvault-passkey',
          to: 'main',
          request: REQUEST,
          result: { kind: 'browser' },
        },
      ]);
    });
  });

  it('passes the session host’s answer to the MAIN-world script, once', async () => {
    const { win, deliver, toMain, runtime } = isolated();
    win.postMessage(FROM_MAIN);
    await vi.waitFor(() => {
      expect(runtime.sendMessage).toHaveBeenCalled();
    });
    deliver(ANSWER, WORKER);
    deliver(ANSWER, WORKER);
    expect(toMain()).toEqual([
      { channel: 'blindvault-passkey', to: 'main', request: REQUEST, result: ASSERTED },
    ]);
  });

  it.each([
    ['a content script', { id: 'abc', tab: { id: 2 } }, ANSWER],
    ['another extension', { id: 'xyz' }, ANSWER],
    ['an unknown key', WORKER, { ...ANSWER, origin: 'https://bank.example' }],
    ['a request this frame did not relay', WORKER, { ...ANSWER, request: 'f'.repeat(32) }],
    ['a result that is not an object', WORKER, { ...ANSWER, result: 'browser' }],
  ])('ignores an answer from %s', async (_name, sender, message) => {
    const { win, deliver, toMain, runtime } = isolated();
    win.postMessage(FROM_MAIN);
    await vi.waitFor(() => {
      expect(runtime.sendMessage).toHaveBeenCalled();
    });
    deliver(message, sender);
    expect(toMain()).toEqual([]);
  });

  it('tells the service worker of a call the page aborted, and drops its answer (P-03)', async () => {
    const { win, deliver, toMain, runtime } = isolated();
    win.postMessage(FROM_MAIN);
    await vi.waitFor(() => {
      expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    });
    const cancel = { channel: 'blindvault-passkey', to: 'isolated', type: 'passkey-cancel' };
    win.postMessage({ ...cancel, request: 'f'.repeat(32) });
    win.postMessage({ ...cancel, request: REQUEST });
    win.postMessage({ ...cancel, request: REQUEST });
    await vi.waitFor(() => {
      expect(runtime.sendMessage).toHaveBeenCalledTimes(2);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.sendMessage).toHaveBeenCalledTimes(2);
    expect(runtime.sendMessage).toHaveBeenLastCalledWith({
      v: 1,
      type: 'passkey-cancel',
      id: 1,
      request: REQUEST,
    });
    deliver(ANSWER, WORKER);
    expect(toMain()).toEqual([]);
  });

  it('ignores another window’s message and a malformed request', async () => {
    const { win, runtime } = isolated();
    win.foreign(FROM_MAIN);
    win.postMessage({ ...FROM_MAIN, request: 'ABC' });
    win.postMessage({ ...FROM_MAIN, type: 'fill' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.sendMessage).not.toHaveBeenCalled();
  });
});
