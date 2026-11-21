import { describe, expect, it } from 'vitest';

import {
  CHALLENGE_MAX,
  CHALLENGE_MIN,
  LIST_MAX,
  NAME_MAX,
  RP_ID_MAX,
  USER_ID_MAX,
  fromBase64url,
  parseCreateOptions,
  parseGetOptions,
  parsePasskeyRequest,
  toBase64url,
} from './passkey-options';

const b64 = (n: number, byte = 1) => toBase64url(new Uint8Array(n).fill(byte));

const CREATE = {
  rp: { id: 'example.com', name: 'Example' },
  user: { id: b64(16), name: 'ana@example.com', displayName: 'Ana' },
  challenge: b64(32),
  pubKeyCredParams: [
    { type: 'public-key', alg: -7 },
    { type: 'public-key', alg: -257 },
  ],
  timeout: 60_000,
  excludeCredentials: [{ type: 'public-key', id: b64(16, 9) }],
  authenticatorSelection: { authenticatorAttachment: 'platform' },
  extensions: { credProps: true },
};
const GET = {
  challenge: b64(32),
  rpId: 'example.com',
  timeout: 60_000,
  allowCredentials: [{ type: 'public-key', id: b64(16, 9) }],
};

const FORWARDED = {
  request: '0123456789abcdef0123456789abcdef',
  tabId: 7,
  frameId: 0,
  origin: 'https://login.example.com',
  topOrigin: 'https://login.example.com',
};

describe('base64url', () => {
  it('round-trips every length and refuses padding, other alphabets and unused bits', () => {
    for (let n = 0; n < 8; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => 250 - i);
      expect(fromBase64url(toBase64url(bytes))).toEqual(bytes);
    }
    expect(toBase64url(Uint8Array.from([0xfb, 0xff]))).toBe('-_8');
    expect(fromBase64url('AQ==')).toBeUndefined();
    expect(fromBase64url('+/8')).toBeUndefined();
    expect(fromBase64url('A')).toBeUndefined();
    // `AR` decodes to the byte of `AQ`, with an unused bit set.
    expect(fromBase64url('AR')).toBeUndefined();
  });
});

describe('parseCreateOptions', () => {
  it('reads every key a site may send', () => {
    const options = parseCreateOptions(CREATE);
    expect(options?.rp).toEqual({ id: 'example.com', name: 'Example' });
    expect(options?.user.id).toEqual(new Uint8Array(16).fill(1));
    expect(options?.challenge).toHaveLength(32);
    expect(options?.pubKeyCredParams).toEqual(CREATE.pubKeyCredParams);
    expect(options?.excludeCredentials?.[0]?.id).toEqual(new Uint8Array(16).fill(9));
    expect(options?.authenticatorSelection).toEqual({ authenticatorAttachment: 'platform' });
    expect(options?.extensions).toEqual({ credProps: true });
    expect(options?.timeout).toBe(60_000);
  });

  it('reads the least a site must send', () => {
    const { rp, user, challenge, pubKeyCredParams } = CREATE;
    const options = parseCreateOptions({
      rp: { name: rp.name },
      user,
      challenge,
      pubKeyCredParams,
    });
    expect(options).toBeDefined();
    expect(options && 'timeout' in options).toBe(false);
    expect(options?.rp.id).toBeUndefined();
  });

  it('refuses an unknown key at any depth', () => {
    expect(parseCreateOptions({ ...CREATE, hints: ['client-device'] })).toBeUndefined();
    expect(parseCreateOptions({ ...CREATE, rp: { ...CREATE.rp, icon: 'x' } })).toBeUndefined();
    expect(parseCreateOptions({ ...CREATE, user: { ...CREATE.user, x: 1 } })).toBeUndefined();
    expect(
      parseCreateOptions({
        ...CREATE,
        authenticatorSelection: { residentKey: 'required' },
      }),
    ).toBeUndefined();
    expect(parseCreateOptions({ ...CREATE, extensions: { prf: {} } })).toBeUndefined();
    expect(
      parseCreateOptions({
        ...CREATE,
        excludeCredentials: [{ type: 'public-key', id: b64(16), transports: ['usb'] }],
      }),
    ).toBeUndefined();
  });

  it('refuses a missing key, an array and an object of another prototype', () => {
    for (const key of ['rp', 'user', 'challenge', 'pubKeyCredParams'] as const) {
      const rest = Object.fromEntries(Object.entries(CREATE).filter(([k]) => k !== key));
      expect(parseCreateOptions(rest)).toBeUndefined();
    }
    expect(parseCreateOptions([CREATE])).toBeUndefined();
    expect(parseCreateOptions(Object.assign(Object.create(Map.prototype), CREATE))).toBeUndefined();
  });

  it('bounds the challenge, the user ID and the credential IDs', () => {
    const at = (patch: object) => parseCreateOptions({ ...CREATE, ...patch });
    expect(at({ challenge: b64(CHALLENGE_MIN) })).toBeDefined();
    expect(at({ challenge: b64(CHALLENGE_MIN - 1) })).toBeUndefined();
    expect(at({ challenge: b64(CHALLENGE_MAX) })).toBeDefined();
    expect(at({ challenge: b64(CHALLENGE_MAX + 1) })).toBeUndefined();
    expect(at({ user: { ...CREATE.user, id: b64(USER_ID_MAX) } })).toBeDefined();
    expect(at({ user: { ...CREATE.user, id: b64(USER_ID_MAX + 1) } })).toBeUndefined();
    expect(at({ user: { ...CREATE.user, id: '' } })).toBeUndefined();
    expect(at({ excludeCredentials: [{ type: 'public-key', id: '' }] })).toBeUndefined();
    expect(at({ excludeCredentials: [{ type: 'public-key', id: b64(1024) }] })).toBeUndefined();
    expect(at({ excludeCredentials: [{ type: 'public-key', id: b64(1023) }] })).toBeDefined();
  });

  it('bounds the lists to 64 entries', () => {
    const many = (n: number) => Array.from({ length: n }, () => ({ type: 'public-key', alg: -7 }));
    expect(parseCreateOptions({ ...CREATE, pubKeyCredParams: many(LIST_MAX) })).toBeDefined();
    expect(parseCreateOptions({ ...CREATE, pubKeyCredParams: many(LIST_MAX + 1) })).toBeUndefined();
    const ids = (n: number) =>
      Array.from({ length: n }, () => ({ type: 'public-key', id: b64(4) }));
    expect(
      parseCreateOptions({ ...CREATE, excludeCredentials: ids(LIST_MAX + 1) }),
    ).toBeUndefined();
  });

  it('bounds the names to 255 code points on one line, well formed', () => {
    const user = (name: string) =>
      parseCreateOptions({ ...CREATE, user: { ...CREATE.user, name } });
    expect(user('😀'.repeat(NAME_MAX))).toBeDefined();
    expect(user('a'.repeat(NAME_MAX + 1))).toBeUndefined();
    expect(user('ana\nbia')).toBeUndefined();
    expect(user('ana\rbia')).toBeUndefined();
    expect(user('\uD800')).toBeUndefined();
    expect(user('')).toBeDefined();
    expect(parseCreateOptions({ ...CREATE, rp: { name: 'a\nb' } })).toBeUndefined();
    expect(
      parseCreateOptions({ ...CREATE, user: { ...CREATE.user, displayName: 'x'.repeat(256) } }),
    ).toBeUndefined();
  });

  it('bounds rp.id to 253 characters and the timeout to a non-negative integer', () => {
    const rp = (id: unknown) => parseCreateOptions({ ...CREATE, rp: { id, name: 'Example' } });
    expect(rp('a'.repeat(RP_ID_MAX))).toBeDefined();
    expect(rp('a'.repeat(RP_ID_MAX + 1))).toBeUndefined();
    expect(rp('')).toBeUndefined();
    expect(rp(1)).toBeUndefined();
    for (const timeout of [-1, 1.5, '60000', Number.MAX_SAFE_INTEGER + 1]) {
      expect(parseCreateOptions({ ...CREATE, timeout })).toBeUndefined();
    }
    expect(parseCreateOptions({ ...CREATE, timeout: 0 })).toBeDefined();
  });

  it('refuses a key of the wrong type', () => {
    expect(
      parseCreateOptions({ ...CREATE, pubKeyCredParams: [{ type: 'public-key', alg: '-7' }] }),
    ).toBeUndefined();
    expect(parseCreateOptions({ ...CREATE, extensions: { credProps: 'yes' } })).toBeUndefined();
    expect(
      parseCreateOptions({ ...CREATE, authenticatorSelection: { authenticatorAttachment: 1 } }),
    ).toBeUndefined();
    expect(parseCreateOptions({ ...CREATE, challenge: new Uint8Array(32) })).toBeUndefined();
  });
});

describe('parseGetOptions', () => {
  it('reads every key a site may send, and the least', () => {
    const options = parseGetOptions(GET);
    expect(options?.rpId).toBe('example.com');
    expect(options?.allowCredentials).toHaveLength(1);
    expect(parseGetOptions({ challenge: GET.challenge })).toEqual({
      challenge: new Uint8Array(32).fill(1),
    });
  });

  it('refuses an unknown or a missing key, and the bounds', () => {
    expect(parseGetOptions({ ...GET, userVerification: 'required' })).toBeUndefined();
    expect(parseGetOptions({ rpId: 'example.com' })).toBeUndefined();
    expect(parseGetOptions({ ...GET, challenge: b64(CHALLENGE_MIN - 1) })).toBeUndefined();
    expect(parseGetOptions({ ...GET, rpId: 'a'.repeat(RP_ID_MAX + 1) })).toBeUndefined();
    expect(parseGetOptions({ ...GET, timeout: -1 })).toBeUndefined();
    expect(parseGetOptions({ ...GET, allowCredentials: [{ id: b64(4) }] })).toBeUndefined();
  });
});

describe('parsePasskeyRequest', () => {
  it('reads what the service worker forwards', () => {
    const request = parsePasskeyRequest('get', { ...FORWARDED, options: GET });
    expect(request?.kind).toBe('get');
    expect(request?.origin).toBe('https://login.example.com');
    expect(parsePasskeyRequest('create', { ...FORWARDED, options: CREATE })?.kind).toBe('create');
  });

  it('refuses a malformed request ID, tab, frame or origin', () => {
    const at = (patch: object) =>
      parsePasskeyRequest('get', { ...FORWARDED, options: GET, ...patch });
    expect(at({ request: 'ABCDEF0123456789abcdef0123456789' })).toBeUndefined();
    expect(at({ request: '0123' })).toBeUndefined();
    expect(at({ tabId: -1 })).toBeUndefined();
    expect(at({ frameId: 0.5 })).toBeUndefined();
    expect(at({ origin: 'null' })).toBeUndefined();
    expect(at({ origin: 'https://login.example.com/' })).toBeUndefined();
    expect(at({ topOrigin: 'https://example.com/path' })).toBeUndefined();
    expect(at({ origin: `https://${'a'.repeat(2048)}.com` })).toBeUndefined();
  });

  it('refuses options of the other call', () => {
    expect(parsePasskeyRequest('create', { ...FORWARDED, options: GET })).toBeUndefined();
    expect(parsePasskeyRequest('get', { ...FORWARDED, options: CREATE })).toBeUndefined();
  });
});
