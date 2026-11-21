import { createPasskey, decodeCbor, initCrypto } from '@blindvault/crypto';
import {
  type Field,
  type Item,
  type ItemInput,
  type ItemView,
  type PasskeyValue,
  type VaultSession,
} from '@blindvault/vault';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { hex } from '../app/ids';
import { type PasskeyAnswer, PasskeyHost } from './passkey-host';
import {
  type CreateOptions,
  type GetOptions,
  type PasskeyRequest,
  fromBase64url,
} from './passkey-options';
import { type ConfirmState, type PasskeyResult } from './rpc';

beforeAll(initCrypto);
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const ORIGIN = 'https://login.example.com';
const CHALLENGE = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const USER = Uint8Array.of(7, 7, 7);

function getRequest(patch: Partial<GetOptions> = {}, origin = ORIGIN): PasskeyRequest {
  return {
    kind: 'get',
    request: 'a'.repeat(32),
    tabId: 4,
    frameId: 2,
    origin,
    topOrigin: origin,
    options: { challenge: CHALLENGE, rpId: 'example.com', ...patch },
  };
}

function createRequest(patch: Partial<CreateOptions> = {}): PasskeyRequest {
  return {
    kind: 'create',
    request: 'b'.repeat(32),
    tabId: 5,
    frameId: 0,
    origin: ORIGIN,
    topOrigin: ORIGIN,
    options: {
      rp: { id: 'example.com', name: ' Example ' },
      user: { id: USER, name: 'ana@example.com', displayName: 'Ana' },
      challenge: CHALLENGE,
      pubKeyCredParams: [
        { type: 'public-key', alg: -8 },
        { type: 'public-key', alg: -7 },
      ],
      ...patch,
    },
  };
}

const id = (n: number) => Uint8Array.from({ length: 16 }, (_, i) => (i === 15 ? n : 0));

function view(n: number, item: Item, extra: Partial<ItemView> = {}): ItemView {
  return { id: id(n), hlc: {} as never, inTrash: false, item, ...extra };
}

function login(title: string, fields: Field[]): Item {
  return { templateId: 'login', templateVersion: 1, title, fields, tags: [] };
}

const URL_FIELD: Field = { type: 'url', role: 'url', value: 'https://login.example.com' };

/** A session host with one session, a window port and the answers it sent. */
function harness(options: { unlocked?: boolean; writable?: boolean; items?: ItemView[] } = {}) {
  let items = options.items ?? [];
  const writes: { kind: 'create' | 'update'; id?: Uint8Array; input: ItemInput }[] = [];
  const session = {
    items: () => items,
    writable: options.writable ?? true,
    createItem: vi.fn((input: ItemInput) => {
      writes.push({ kind: 'create', input });
      items = [...items, view(90 + writes.length, input)];
      return Promise.resolve(id(90 + writes.length));
    }),
    updateItem: vi.fn((itemId: Uint8Array, input: ItemInput) => {
      writes.push({ kind: 'update', id: itemId, input });
      items = items.map((v) => (hex(v.id) === hex(itemId) ? { ...v, item: input } : v));
      return Promise.resolve(true);
    }),
  } as unknown as VaultSession & { writable: boolean };
  let status: { kind: string; session?: VaultSession } =
    options.unlocked === false ? { kind: 'locked' } : { kind: 'unlocked', session };
  const listeners = new Set<() => void>();
  const app = {
    get status() {
      return status;
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const setUnlocked = (on: boolean) => {
    status = on ? { kind: 'unlocked', session } : { kind: 'locked' };
    for (const l of listeners) l();
  };
  let removed: (windowId: number) => void = () => undefined;
  let nextWindow = 100;
  const opened: string[] = [];
  const closed: number[] = [];
  const answers: PasskeyAnswer[] = [];
  let tokens = 0;
  const host = new PasskeyHost({
    app,
    windows: {
      open: (token) => {
        opened.push(token);
        return Promise.resolve(nextWindow++);
      },
      close: (windowId) => {
        closed.push(windowId);
      },
      onRemoved: (listener) => {
        removed = listener;
      },
    },
    answer: (a) => answers.push(a),
    token: () => (++tokens).toString(16).padStart(32, '0'),
    now: () => 1_790_000_000_000,
  });
  const token = () => {
    const last = opened.at(-1);
    if (last === undefined) throw new Error('no window');
    return last;
  };
  return {
    host,
    session,
    writes,
    opened,
    closed,
    answers,
    token,
    setUnlocked,
    removeWindow: (windowId: number) => {
      removed(windowId);
    },
    items: () => items,
  };
}

/** Lets the window's promise settle. */
const settle = () => vi.advanceTimersByTimeAsync(0);

function result(answers: readonly PasskeyAnswer[]): PasskeyResult {
  const last = answers.at(-1);
  if (!last) throw new Error('no answer');
  return last.result;
}

async function stored(rpId: string, algorithm: 'ES256' | 'EdDSA', credential: number) {
  const created = await createPasskey(rpId, algorithm);
  const value: PasskeyValue = {
    privateKey: created.privateKey,
    credentialId: Uint8Array.of(credential),
    rpId,
    userHandle: USER,
    userName: 'ana',
    createdAt: 0,
  };
  return { value, publicKey: created.publicKey };
}

const bytesOf = (text: string) => {
  const bytes = fromBase64url(text);
  if (!bytes) throw new Error(`not base64url: ${text}`);
  return bytes;
};

const sha256 = async (data: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(data)));

/** A DER `Ecdsa-Sig-Value` as WebCrypto's `r ‖ s`. */
function rawEcdsa(der: Uint8Array): Uint8Array {
  const out = new Uint8Array(64);
  let at = 2;
  for (const half of [0, 32]) {
    const length = der[at + 1] ?? 0;
    const value = der.subarray(at + 2, at + 2 + length);
    const trimmed = value.subarray(Math.max(0, value.length - 32));
    out.set(trimmed, half + 32 - trimmed.length);
    at += 2 + length;
  }
  return out;
}

/** Verifies a WebAuthn signature with the SPKI public key the page receives. */
async function verifies(
  algorithm: 'ES256' | 'EdDSA',
  spki: Uint8Array,
  signature: Uint8Array,
  signed: Uint8Array,
): Promise<boolean> {
  const params =
    algorithm === 'ES256'
      ? ({ name: 'ECDSA', namedCurve: 'P-256' } as const)
      : ({ name: 'Ed25519' } as const);
  const key = await crypto.subtle.importKey('spki', new Uint8Array(spki), params, false, [
    'verify',
  ]);
  return crypto.subtle.verify(
    algorithm === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'Ed25519' },
    key,
    new Uint8Array(algorithm === 'ES256' ? rawEcdsa(signature) : signature),
    new Uint8Array(signed),
  );
}

describe('PasskeyHost: get (extension.md §7.4, CRYPTO-INV-027)', () => {
  it('signs only after the click, with the chosen passkey, for the reported origin', async () => {
    const es = await stored('example.com', 'ES256', 1);
    const ed = await stored('example.com', 'EdDSA', 2);
    const h = harness({
      items: [
        view(1, login('Mail', [URL_FIELD, { type: 'passkey', value: es.value }])),
        view(2, login('Work', [URL_FIELD, { type: 'passkey', value: ed.value }])),
      ],
    });
    h.host.start(getRequest());
    await settle();
    expect(h.opened).toHaveLength(1);
    expect(h.answers).toEqual([]);
    const details = h.host.details(h.token()) as Extract<ConfirmState, { kind: 'get' }>;
    expect(details).toEqual({
      kind: 'get',
      origin: ORIGIN,
      rpId: 'example.com',
      passkeys: [
        { credentialId: '01', title: 'Mail', userName: 'ana' },
        { credentialId: '02', title: 'Work', userName: 'ana' },
      ],
    });
    expect(JSON.stringify(details)).not.toContain('privateKey');

    for (const [credentialId, key] of [
      ['01', es],
      ['02', ed],
    ] as const) {
      if (credentialId === '02') {
        h.host.start(getRequest());
        await settle();
      }
      await expect(h.host.choose(h.token(), { choice: 'use', credentialId })).resolves.toBe(true);
      const answer = h.answers.at(-1);
      expect(answer).toMatchObject({ tabId: 4, frameId: 2, request: 'a'.repeat(32) });
      const r = result(h.answers);
      if (r.kind !== 'asserted') throw new Error(r.kind);
      expect(bytesOf(r.id)).toEqual(key.value.credentialId);
      expect(bytesOf(r.userHandle)).toEqual(USER);
      const data = bytesOf(r.authenticatorData);
      // rpIdHash, flags UP, UV, BE and BS, signCount 0 (§7.3).
      expect(data.subarray(0, 32)).toEqual(await sha256(new TextEncoder().encode('example.com')));
      expect(data[32]).toBe(0x1d);
      expect(data.subarray(33)).toEqual(new Uint8Array(4));
      const client = bytesOf(r.clientDataJSON);
      expect(JSON.parse(new TextDecoder().decode(client))).toEqual({
        type: 'webauthn.get',
        challenge: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA',
        origin: ORIGIN,
        crossOrigin: false,
      });
      const signed = new Uint8Array([...data, ...(await sha256(client))]);
      const algorithm = credentialId === '01' ? 'ES256' : 'EdDSA';
      await expect(verifies(algorithm, key.publicKey, bytesOf(r.signature), signed)).resolves.toBe(
        true,
      );
      // The same signature over another challenge does not verify.
      signed.set([(signed.at(-1) ?? 0) ^ 1], signed.length - 1);
      await expect(verifies(algorithm, key.publicKey, bytesOf(r.signature), signed)).resolves.toBe(
        false,
      );
    }
    // Each window closed once its request ended.
    expect(h.closed).toEqual([100, 101]);
  });

  it('keeps only the passkeys allowCredentials lists, and refuses another credentialId', async () => {
    const es = await stored('example.com', 'ES256', 1);
    const h = harness({
      items: [view(1, login('Mail', [{ type: 'passkey', value: es.value }]))],
    });
    h.host.start(getRequest({ allowCredentials: [{ type: 'public-key', id: Uint8Array.of(9) }] }));
    await settle();
    expect(h.host.details(h.token())).toMatchObject({ passkeys: [] });
    await expect(h.host.choose(h.token(), { choice: 'use', credentialId: '01' })).resolves.toBe(
      'not-found',
    );
    expect(h.answers).toEqual([]);
  });

  it('adds topOrigin in a frame of another origin', async () => {
    const es = await stored('pay.example', 'ES256', 1);
    const h = harness({ items: [view(1, login('Pay', [{ type: 'passkey', value: es.value }]))] });
    h.host.start({
      ...getRequest({ rpId: 'pay.example' }, 'https://pay.example'),
      topOrigin: 'https://shop.example',
    });
    await settle();
    expect(h.host.details(h.token())).toMatchObject({
      origin: 'https://pay.example',
      topOrigin: 'https://shop.example',
    });
    await h.host.choose(h.token(), { choice: 'use', credentialId: '01' });
    const r = result(h.answers);
    if (r.kind !== 'asserted') throw new Error(r.kind);
    expect(JSON.parse(new TextDecoder().decode(bytesOf(r.clientDataJSON)))).toMatchObject({
      crossOrigin: true,
      topOrigin: 'https://shop.example',
    });
  });

  it('signs on a read-only vault, since a get writes nothing (§7.4)', async () => {
    const es = await stored('example.com', 'ES256', 1);
    const h = harness({
      writable: false,
      items: [view(1, login('Mail', [{ type: 'passkey', value: es.value }]))],
    });
    h.host.start(getRequest());
    await settle();
    await h.host.choose(h.token(), { choice: 'use', credentialId: '01' });
    expect(result(h.answers).kind).toBe('asserted');
    expect(h.writes).toEqual([]);
  });
});

describe('PasskeyHost: checks before any window (extension.md §7.2)', () => {
  it('hands to the browser an rpId of another site, a public suffix, and an http: page', async () => {
    for (const request of [
      getRequest({ rpId: 'other.example' }),
      getRequest({ rpId: 'com' }),
      getRequest({}, 'http://login.example.com'),
      createRequest({ authenticatorSelection: { authenticatorAttachment: 'cross-platform' } }),
      createRequest({ pubKeyCredParams: [{ type: 'public-key', alg: -257 }] }),
    ]) {
      const h = harness();
      h.host.start(request);
      await settle();
      expect(h.opened).toEqual([]);
      expect(h.answers).toEqual([
        {
          tabId: request.tabId,
          frameId: request.frameId,
          request: request.request,
          result: { kind: 'browser' },
        },
      ]);
    }
  });

  it('hands a create on a read-only vault to the browser at once, with no window (D73)', async () => {
    const h = harness({ writable: false });
    h.host.start(createRequest());
    await settle();
    expect(h.opened).toEqual([]);
    expect(result(h.answers)).toEqual({ kind: 'browser' });
  });

  it('answers a second request NotAllowedError at once, with no window (D289)', async () => {
    const h = harness();
    h.host.start(getRequest());
    await settle();
    h.host.start({ ...createRequest(), tabId: 9 });
    await settle();
    expect(h.opened).toHaveLength(1);
    expect(h.answers).toEqual([
      {
        tabId: 9,
        frameId: 0,
        request: 'b'.repeat(32),
        result: { kind: 'error', name: 'NotAllowedError' },
      },
    ]);
    expect(h.host.details(h.token())).toMatchObject({ kind: 'get' });
  });
});

describe('PasskeyHost: create (extension.md §7.4)', () => {
  it('saves a new Login item after the click, and answers what the page needs', async () => {
    const h = harness();
    h.host.start(createRequest());
    await settle();
    expect(h.writes).toEqual([]);
    expect(h.host.details(h.token())).toEqual({
      kind: 'create',
      origin: ORIGIN,
      rpId: 'example.com',
      rpName: ' Example ',
      userName: 'ana@example.com',
      displayName: 'Ana',
      items: [],
      replaces: false,
    });
    await expect(h.host.choose(h.token(), { choice: 'save-new' })).resolves.toBe(true);
    expect(h.writes).toHaveLength(1);
    const input = h.writes[0]?.input;
    expect(input?.title).toBe('Example');
    expect(input?.fields.slice(0, 2)).toEqual([
      { type: 'text', role: 'username', value: 'ana@example.com' },
      { type: 'url', role: 'url', value: 'https://example.com' },
    ]);
    const field = input?.fields[2];
    if (
      field?.type !== 'passkey' ||
      typeof field.value !== 'object' ||
      !('privateKey' in field.value)
    ) {
      throw new Error('no passkey field');
    }
    const value = field.value;
    expect(value.rpId).toBe('example.com');
    expect(value.userHandle).toEqual(USER);
    expect(value.userName).toBe('ana@example.com');
    expect(value.createdAt).toBe(1_790_000_000_000);
    // The key the field held during the write is wiped once written: the session keeps a copy.
    expect(value.privateKey.every((b) => b === 0)).toBe(true);

    const r = result(h.answers);
    if (r.kind !== 'created') throw new Error(r.kind);
    expect(bytesOf(r.id)).toEqual(value.credentialId);
    expect(r.publicKeyAlgorithm).toBe(-7);
    const attestation = decodeCbor(bytesOf(r.attestationObject)) as Map<string, unknown>;
    expect(attestation.get('fmt')).toBe('none');
    expect(attestation.get('authData')).toEqual(bytesOf(r.authenticatorData));
    expect(bytesOf(r.authenticatorData)[32]).toBe(0x5d);
    expect(JSON.parse(new TextDecoder().decode(bytesOf(r.clientDataJSON)))).toMatchObject({
      type: 'webauthn.create',
      origin: ORIGIN,
    });
    expect(h.closed).toEqual([100]);
  });

  it('titles a new item with the rpId when rp.name is blank, and leaves out an empty user name', async () => {
    const h = harness();
    h.host.start(
      createRequest({
        rp: { name: '  ' },
        user: { id: USER, name: '', displayName: '' },
      }),
    );
    await settle();
    await h.host.choose(h.token(), { choice: 'save-new' });
    expect(h.writes[0]?.input.title).toBe('login.example.com');
    expect(h.writes[0]?.input.fields.map((f) => f.type)).toEqual(['url', 'passkey']);
  });

  it('saves into a matching item it lists, and refuses one it does not', async () => {
    const mail = view(
      1,
      login('Mail', [{ type: 'text', role: 'username', value: 'ana' }, URL_FIELD]),
    );
    const other = view(
      2,
      login('Other', [{ type: 'url', role: 'url', value: 'https://other.com' }]),
    );
    const h = harness({ items: [mail, other] });
    h.host.start(createRequest());
    await settle();
    expect(h.host.details(h.token())).toMatchObject({
      items: [{ itemId: hex(id(1)), title: 'Mail', username: 'ana' }],
    });
    await expect(h.host.choose(h.token(), { choice: 'save', itemId: hex(id(2)) })).resolves.toBe(
      'not-found',
    );
    await expect(h.host.choose(h.token(), { choice: 'save', itemId: hex(id(1)) })).resolves.toBe(
      true,
    );
    expect(h.writes.map((w) => [w.kind, w.id && hex(w.id)])).toEqual([['update', hex(id(1))]]);
    expect(h.writes[0]?.input.fields.map((f) => f.type)).toEqual(['text', 'url', 'passkey']);
  });

  it('replaces a held passkey of the rpId and userHandle in every item holding it', async () => {
    const old = (await stored('example.com', 'EdDSA', 1)).value;
    const a = view(1, login('Mail', [URL_FIELD, { type: 'passkey', value: old }]));
    const b = view(2, login('Mail copy', [{ type: 'passkey', value: old }]));
    const h = harness({ items: [a, b] });
    h.host.start(createRequest());
    await settle();
    expect(h.host.details(h.token())).toMatchObject({ replaces: true });
    await h.host.choose(h.token(), { choice: 'save', itemId: hex(id(1)) });
    expect(h.writes.map((w) => hex(w.id ?? new Uint8Array()))).toEqual([hex(id(2)), hex(id(1))]);
    for (const w of h.writes) {
      const passkeys = w.input.fields.filter((f) => f.type === 'passkey');
      expect(passkeys).toHaveLength(1);
      const value = passkeys[0]?.value as PasskeyValue;
      expect(value.credentialId).not.toEqual(old.credentialId);
    }
    expect(result(h.answers).kind).toBe('created');
  });

  it('answers InvalidStateError only after the click when excludeCredentials lists a held one', async () => {
    const old = (await stored('example.com', 'EdDSA', 1)).value;
    const h = harness({ items: [view(1, login('Mail', [{ type: 'passkey', value: old }]))] });
    h.host.start(
      createRequest({ excludeCredentials: [{ type: 'public-key', id: Uint8Array.of(1) }] }),
    );
    await settle();
    expect(h.answers).toEqual([]);
    await h.host.choose(h.token(), { choice: 'save-new' });
    expect(result(h.answers)).toEqual({ kind: 'error', name: 'InvalidStateError' });
    expect(h.writes).toEqual([]);
  });

  it('writes nothing when an item holding the replaced passkey is read-only', async () => {
    const old = (await stored('example.com', 'EdDSA', 1)).value;
    const frozen = view(1, login('Mail', [{ type: 'passkey', value: old }]), {
      readOnly: 'future-clock',
    });
    const h = harness({ items: [frozen] });
    h.host.start(createRequest());
    await settle();
    await h.host.choose(h.token(), { choice: 'save-new' });
    expect(h.writes).toEqual([]);
    expect(result(h.answers)).toEqual({ kind: 'error', name: 'NotAllowedError' });
  });

  it('refuses a get choice for a create, and the other way round', async () => {
    const h = harness();
    h.host.start(createRequest());
    await settle();
    await expect(h.host.choose(h.token(), { choice: 'use', credentialId: '01' })).resolves.toBe(
      'invalid',
    );
    await h.host.choose(h.token(), { choice: 'cancel' });
    h.host.start(getRequest());
    await settle();
    await expect(h.host.choose(h.token(), { choice: 'save-new' })).resolves.toBe('invalid');
  });
});

describe('PasskeyHost: the window and the request (extension.md §7.4, §7.7, D289)', () => {
  it('ends with NotAllowedError on Cancel, and goes to the browser on another authenticator', async () => {
    const h = harness();
    h.host.start(getRequest());
    await settle();
    await h.host.choose(h.token(), { choice: 'cancel' });
    expect(result(h.answers)).toEqual({ kind: 'error', name: 'NotAllowedError' });
    h.host.start(getRequest());
    await settle();
    await h.host.choose(h.token(), { choice: 'browser' });
    expect(result(h.answers)).toEqual({ kind: 'browser' });
    expect(h.closed).toEqual([100, 101]);
  });

  it('answers not-found to another token, and to an old window once the request ended', async () => {
    const h = harness();
    h.host.start(getRequest());
    await settle();
    const token = h.token();
    expect(h.host.details('f'.repeat(32))).toBe('not-found');
    await expect(h.host.choose('f'.repeat(32), { choice: 'cancel' })).resolves.toBe('not-found');
    await h.host.choose(token, { choice: 'cancel' });
    h.host.start(getRequest());
    await settle();
    expect(h.host.details(token)).toBe('not-found');
    await expect(h.host.choose(token, { choice: 'browser' })).resolves.toBe('not-found');
  });

  it('ends with NotAllowedError when the user closes the window, ignoring other windows', async () => {
    const h = harness();
    h.host.start(getRequest());
    await settle();
    h.removeWindow(7);
    expect(h.answers).toEqual([]);
    h.removeWindow(100);
    expect(result(h.answers)).toEqual({ kind: 'error', name: 'NotAllowedError' });
    // Closed by the user: not closed again.
    expect(h.closed).toEqual([]);
  });

  it('ends with NotAllowedError once the timeout elapses, bounded to 30 s to 600 s', async () => {
    const h = harness();
    h.host.start(getRequest({ timeout: 1_000 }));
    await settle();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.answers).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(result(h.answers)).toEqual({ kind: 'error', name: 'NotAllowedError' });
    expect(h.closed).toEqual([100]);

    h.host.start(getRequest());
    await settle();
    await vi.advanceTimersByTimeAsync(299_999);
    expect(h.answers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.answers).toHaveLength(2);

    h.host.start(getRequest({ timeout: 3_600_000 }));
    await settle();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.answers).toHaveLength(3);
  });

  it('a lock closes the window and ends the request with NotAllowedError (§3.2)', async () => {
    const h = harness();
    h.host.start(getRequest());
    await settle();
    h.setUnlocked(false);
    expect(h.closed).toEqual([100]);
    expect(result(h.answers)).toEqual({ kind: 'error', name: 'NotAllowedError' });
    await expect(h.host.choose(h.token(), { choice: 'cancel' })).resolves.toBe('not-found');
  });

  it('while locked shows the locked state, and on unlock opens the window again, under a new token', async () => {
    const es = await stored('example.com', 'ES256', 1);
    const h = harness({
      unlocked: false,
      items: [view(1, login('Mail', [{ type: 'passkey', value: es.value }]))],
    });
    h.host.start(getRequest());
    await settle();
    const first = h.token();
    expect(h.host.details(first)).toEqual({ kind: 'locked' });
    await expect(h.host.choose(first, { choice: 'use', credentialId: '01' })).resolves.toBe(
      'locked',
    );
    h.setUnlocked(true);
    await settle();
    expect(h.closed).toEqual([100]);
    expect(h.opened).toHaveLength(2);
    expect(h.host.details(first)).toBe('not-found');
    expect(h.host.details(h.token())).toMatchObject({ kind: 'get' });
    // The window the session host closed does not end the request.
    h.removeWindow(100);
    expect(h.answers).toEqual([]);
    await h.host.choose(h.token(), { choice: 'use', credentialId: '01' });
    expect(result(h.answers).kind).toBe('asserted');
  });

  it('while locked offers another authenticator and Cancel', async () => {
    const h = harness({ unlocked: false });
    h.host.start(createRequest());
    await settle();
    await h.host.choose(h.token(), { choice: 'browser' });
    expect(result(h.answers)).toEqual({ kind: 'browser' });
  });

  it('hands a create to the browser when the vault unlocks read-only (D73)', async () => {
    const h = harness({ unlocked: false, writable: false });
    h.host.start(createRequest());
    await settle();
    h.setUnlocked(true);
    expect(result(h.answers)).toEqual({ kind: 'browser' });
    expect(h.closed).toEqual([100]);
  });

  it('ends with NotAllowedError when the browser opens no window', async () => {
    const h = harness();
    const host = new PasskeyHost({
      app: { status: { kind: 'locked' }, subscribe: () => () => undefined },
      windows: {
        open: () => Promise.reject(new Error('no window')),
        close: () => undefined,
        onRemoved: () => undefined,
      },
      answer: (a) => h.answers.push(a),
      token: () => 'c'.repeat(32),
      now: Date.now,
    });
    host.start(getRequest());
    await settle();
    expect(result(h.answers)).toEqual({ kind: 'error', name: 'NotAllowedError' });
  });
});
