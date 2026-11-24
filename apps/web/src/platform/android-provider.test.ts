import { describe, expect, it } from 'vitest';

import { toBase64url } from '../extension/passkey-options';
import { type PasskeyResult } from '../extension/rpc';
import { parseProviderRequest, pickOptions, providerResult } from './android-provider';

const HASH = Uint8Array.from({ length: 32 }, (_, i) => i);
const CHALLENGE = toBase64url(Uint8Array.from({ length: 32 }, (_, i) => 255 - i));
const ORIGIN = 'https://webauthn.io';
const BROWSER = { kind: 'browser', origin: ORIGIN, packageName: 'com.android.chrome' };

/** A WebAuthn options JSON as Chrome passes it, keys the provider drops included. */
const CREATE_JSON = {
  rp: { id: 'webauthn.io', name: 'WebAuthn.io' },
  user: { id: toBase64url(Uint8Array.of(1, 2, 3)), name: 'ana', displayName: 'Ana' },
  challenge: CHALLENGE,
  pubKeyCredParams: [
    { type: 'public-key', alg: -8 },
    { type: 'public-key', alg: -7 },
  ],
  timeout: 60000,
  excludeCredentials: [
    { type: 'public-key', id: toBase64url(Uint8Array.of(9)), transports: ['internal'] },
  ],
  authenticatorSelection: {
    authenticatorAttachment: 'platform',
    residentKey: 'required',
    requireResidentKey: true,
    userVerification: 'preferred',
  },
  attestation: 'none',
  hints: ['client-device'],
  extensions: { credProps: true, prf: {} },
};

const GET_JSON = {
  challenge: CHALLENGE,
  rpId: 'webauthn.io',
  timeout: 60000,
  allowCredentials: [
    { type: 'public-key', id: toBase64url(Uint8Array.of(9)), transports: ['hybrid'] },
  ],
  userVerification: 'preferred',
  extensions: { prf: {} },
};

function answer(fields: Record<string, unknown>): Record<string, unknown> {
  return { v: 1, id: 1, ok: true, ...fields };
}

const createAnswer = (patch: Record<string, unknown> = {}) =>
  answer({
    kind: 'create',
    caller: BROWSER,
    requestJson: JSON.stringify(CREATE_JSON),
    clientDataHash: toBase64url(HASH),
    ...patch,
  });

describe('pickOptions (android.md §7.7, D301)', () => {
  it('copies only the keys of extension.md §7.7, each credential reduced to {type, id}', () => {
    expect(pickOptions('create', CREATE_JSON)).toEqual({
      rp: { id: 'webauthn.io', name: 'WebAuthn.io' },
      user: CREATE_JSON.user,
      challenge: CHALLENGE,
      pubKeyCredParams: CREATE_JSON.pubKeyCredParams,
      timeout: 60000,
      excludeCredentials: [{ type: 'public-key', id: toBase64url(Uint8Array.of(9)) }],
      authenticatorSelection: { authenticatorAttachment: 'platform' },
      extensions: { credProps: true },
    });
    expect(pickOptions('get', GET_JSON)).toEqual({
      challenge: CHALLENGE,
      rpId: 'webauthn.io',
      timeout: 60000,
      allowCredentials: [{ type: 'public-key', id: toBase64url(Uint8Array.of(9)) }],
    });
  });

  it('leaves out an absent key rather than writing it as undefined', () => {
    expect(pickOptions('get', { challenge: CHALLENGE })).toEqual({ challenge: CHALLENGE });
    expect(Object.keys(pickOptions('get', { challenge: CHALLENGE }) as object)).toEqual([
      'challenge',
    ]);
  });

  it('passes a value of the wrong shape through, for the checks to refuse', () => {
    expect(pickOptions('get', { challenge: 7, allowCredentials: 'x' })).toEqual({
      challenge: 7,
      allowCredentials: 'x',
    });
    expect(pickOptions('get', [])).toBeUndefined();
    expect(pickOptions('create', null)).toBeUndefined();
  });
});

describe('parseProviderRequest (android.md §7.7, D301)', () => {
  it('takes a privileged browser’s create with its origin and clientDataHash', () => {
    const request = parseProviderRequest(createAnswer());
    expect(request?.caller).toEqual(BROWSER);
    expect(request?.clientDataHash).toEqual(HASH);
    expect(request?.call.kind).toBe('create');
    expect(request?.call.origin).toBe(ORIGIN);
    expect(request?.call.topOrigin).toBe(ORIGIN);
    expect(request?.call.options).toMatchObject({ rp: { id: 'webauthn.io' }, timeout: 60000 });
  });

  it('takes a get', () => {
    const request = parseProviderRequest(
      createAnswer({ kind: 'get', requestJson: JSON.stringify(GET_JSON) }),
    );
    expect(request?.call.kind).toBe('get');
    expect(request?.call.options).toMatchObject({ rpId: 'webauthn.io' });
  });

  it('refuses a missing, an unknown or a mistyped key', () => {
    const withoutHash = Object.fromEntries(
      Object.entries(createAnswer()).filter(([k]) => k !== 'clientDataHash'),
    );
    expect(parseProviderRequest(withoutHash)).toBeUndefined();
    expect(parseProviderRequest(createAnswer({ extra: 1 }))).toBeUndefined();
    expect(parseProviderRequest(createAnswer({ kind: 'delete' }))).toBeUndefined();
    expect(parseProviderRequest(createAnswer({ requestJson: CREATE_JSON }))).toBeUndefined();
  });

  it('refuses a clientDataHash that is not 32 bytes of canonical base64url', () => {
    for (const hash of [
      toBase64url(HASH.subarray(1)),
      toBase64url(new Uint8Array(33)),
      `${toBase64url(HASH)}=`,
      toBase64url(HASH).replace(/.$/, '+'),
      32,
    ]) {
      expect(parseProviderRequest(createAnswer({ clientDataHash: hash }))).toBeUndefined();
    }
  });

  it('refuses a caller other than a privileged browser with an https origin (D301 Order)', () => {
    const callers: unknown[] = [
      { kind: 'app', packageName: 'com.example', certSha256: ['ab'.repeat(32)] },
      { ...BROWSER, origin: 'http://webauthn.io' },
      { ...BROWSER, origin: 'https://webauthn.io/' },
      { ...BROWSER, origin: 'https://webauthn.io/path' },
      { ...BROWSER, origin: 'null' },
      { ...BROWSER, packageName: '' },
      { ...BROWSER, extra: true },
      { kind: 'browser', origin: ORIGIN },
      'browser',
    ];
    for (const caller of callers) {
      expect(parseProviderRequest(createAnswer({ caller }))).toBeUndefined();
    }
  });

  it('refuses options JSON that does not parse, is too long, or fails the checks', () => {
    expect(parseProviderRequest(createAnswer({ requestJson: '{' }))).toBeUndefined();
    expect(parseProviderRequest(createAnswer({ requestJson: '[]' }))).toBeUndefined();
    const long = JSON.stringify({ ...CREATE_JSON, padding: 'x'.repeat(65536) });
    expect(parseProviderRequest(createAnswer({ requestJson: long }))).toBeUndefined();
    const shortChallenge = JSON.stringify({
      ...CREATE_JSON,
      challenge: toBase64url(new Uint8Array(8)),
    });
    expect(parseProviderRequest(createAnswer({ requestJson: shortChallenge }))).toBeUndefined();
    const noUser = JSON.stringify({ ...CREATE_JSON, user: undefined });
    expect(parseProviderRequest(createAnswer({ requestJson: noUser }))).toBeUndefined();
    // A get's options under a create.
    expect(
      parseProviderRequest(createAnswer({ requestJson: JSON.stringify(GET_JSON) })),
    ).toBeUndefined();
  });
});

describe('providerResult (android.md §7.7, D301)', () => {
  const asserted: PasskeyResult = {
    kind: 'asserted',
    id: 'aWQ',
    clientDataJSON: 'Y2Q',
    authenticatorData: 'YWQ',
    signature: 'c2ln',
    userHandle: 'dWg',
  };
  const created: PasskeyResult = {
    kind: 'created',
    id: 'aWQ',
    clientDataJSON: 'Y2Q',
    attestationObject: 'YW8',
    authenticatorData: 'YWQ',
    publicKey: 'cGs',
    publicKeyAlgorithm: -7,
  };

  it('leaves clientDataJSON out for a privileged browser, which writes its own', () => {
    const without = (r: PasskeyResult) =>
      Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'clientDataJSON'));
    expect(providerResult(asserted)).toEqual(without(asserted));
    expect(providerResult(created)).toEqual(without(created));
    expect(providerResult(asserted)).not.toHaveProperty('clientDataJSON');
  });

  it('passes errors, a cancellation and another authenticator as they are', () => {
    expect(providerResult({ kind: 'error', name: 'InvalidStateError' })).toEqual({
      kind: 'error',
      name: 'InvalidStateError',
    });
    expect(providerResult({ kind: 'cancelled' })).toEqual({ kind: 'cancelled' });
    expect(providerResult({ kind: 'browser' })).toEqual({ kind: 'browser' });
  });
});
