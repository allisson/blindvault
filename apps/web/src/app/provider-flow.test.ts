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
import { type ProviderApp, ProviderFlow } from './provider-flow';

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
  options: { status?: string; writable?: boolean; items?: ItemView[] } = {},
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
  const flow = new ProviderFlow({
    app,
    shell: {
      request: () =>
        request instanceof Error ? Promise.reject(request) : Promise.resolve(request as never),
      result: (r) => results.push(r),
    },
    now: () => 1_790_000_000_000,
  });
  return { flow, takeOver, lock, session, set, results, items: () => items };
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
