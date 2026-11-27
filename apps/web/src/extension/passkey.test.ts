import { type Field, type ItemView, type PasskeyValue } from '@blindvault/vault';
import { describe, expect, it } from 'vitest';

import {
  TIMEOUT_DEFAULT,
  TIMEOUT_MAX,
  TIMEOUT_MIN,
  candidates,
  checkRequest,
  clientDataJSON,
  holders,
  holdsExcluded,
  rpIdServes,
  saveTargets,
  timeoutOf,
  withPasskey,
} from './passkey';
import { type CreateOptions, type GetOptions, type PasskeyRequest } from './passkey-options';

const CHALLENGE = Uint8Array.from({ length: 32 }, (_, i) => i);

function create(
  origin: string,
  patch: Partial<CreateOptions> = {},
  topOrigin = origin,
): PasskeyRequest {
  return {
    kind: 'create',
    request: '0'.repeat(32),
    tabId: 1,
    frameId: 0,
    origin,
    topOrigin,
    options: {
      rp: { name: 'Example' },
      user: { id: Uint8Array.of(1), name: 'ana', displayName: 'Ana' },
      challenge: CHALLENGE,
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      ...patch,
    },
  };
}

function get(origin: string, patch: Partial<GetOptions> = {}, topOrigin = origin): PasskeyRequest {
  return {
    kind: 'get',
    request: '0'.repeat(32),
    tabId: 1,
    frameId: 3,
    origin,
    topOrigin,
    options: { challenge: CHALLENGE, ...patch },
  };
}

describe('rpIdServes (extension.md §7.2 step 2)', () => {
  it('takes the host, and a registrable suffix of it', () => {
    expect(rpIdServes('login.example.com', 'login.example.com')).toBe(true);
    expect(rpIdServes('example.com', 'login.example.com')).toBe(true);
    expect(rpIdServes('example.co.uk', 'a.b.example.co.uk')).toBe(true);
    expect(rpIdServes('localhost', 'localhost')).toBe(true);
  });

  it('refuses another site, a public suffix, a private-section suffix and a part of a label', () => {
    expect(rpIdServes('other.com', 'login.example.com')).toBe(false);
    expect(rpIdServes('com', 'example.com')).toBe(false);
    expect(rpIdServes('co.uk', 'example.co.uk')).toBe(false);
    expect(rpIdServes('github.io', 'ana.github.io')).toBe(false);
    expect(rpIdServes('ample.com', 'example.com')).toBe(false);
    expect(rpIdServes('login.example.com', 'example.com')).toBe(false);
  });

  it('never lets an IP address be an rpId, as browsers refuse one (P-05)', () => {
    expect(rpIdServes('1.2.3.4', '1.2.3.4')).toBe(false);
    expect(rpIdServes('3.4', '1.2.3.4')).toBe(false);
    expect(rpIdServes('[::1]', '[::1]')).toBe(false);
    expect(checkRequest(get('https://192.168.0.1'))).toBeUndefined();
    expect(checkRequest(get('https://[::1]:8443'))).toBeUndefined();
  });
});

describe('checkRequest (extension.md §7.2)', () => {
  it('takes https: and http://localhost, with the origin host as the default rpId', () => {
    expect(checkRequest(get('https://login.example.com'))).toEqual({
      kind: 'get',
      rpId: 'login.example.com',
    });
    expect(checkRequest(get('http://localhost:5173'))).toEqual({ kind: 'get', rpId: 'localhost' });
    expect(checkRequest(create('https://example.com'))).toEqual({
      kind: 'create',
      rpId: 'example.com',
      algorithm: 'ES256',
    });
  });

  it('hands to the browser a page on http:, and an rpId of another site or a public suffix', () => {
    expect(checkRequest(get('http://example.com'))).toBeUndefined();
    expect(checkRequest(get('https://example.com', { rpId: 'other.com' }))).toBeUndefined();
    expect(checkRequest(get('https://example.com', { rpId: 'com' }))).toBeUndefined();
    expect(
      checkRequest(create('https://ana.github.io', { rp: { id: 'github.io', name: 'x' } })),
    ).toBeUndefined();
    expect(checkRequest(get('https://login.example.com', { rpId: 'example.com' }))).toEqual({
      kind: 'get',
      rpId: 'example.com',
    });
  });

  it('prefers ES256, takes EdDSA, and hands any other algorithm to the browser', () => {
    const algs = (...alg: number[]) =>
      checkRequest(
        create('https://example.com', {
          pubKeyCredParams: alg.map((a) => ({ type: 'public-key', alg: a })),
        }),
      );
    expect(algs(-8, -7)).toMatchObject({ algorithm: 'ES256' });
    expect(algs(-257, -8)).toMatchObject({ algorithm: 'EdDSA' });
    expect(algs(-257)).toBeUndefined();
    expect(algs()).toBeUndefined();
    expect(
      checkRequest(
        create('https://example.com', { pubKeyCredParams: [{ type: 'other', alg: -7 }] }),
      ),
    ).toBeUndefined();
  });

  it('hands a create asking for cross-platform to the browser (D288)', () => {
    const at = (authenticatorAttachment: string) =>
      checkRequest(
        create('https://example.com', { authenticatorSelection: { authenticatorAttachment } }),
      );
    expect(at('cross-platform')).toBeUndefined();
    expect(at('platform')).toBeDefined();
  });
});

describe('timeoutOf (D289)', () => {
  it('bounds the page timeout to 30 s to 600 s, 300 s without one', () => {
    expect(timeoutOf(undefined)).toBe(TIMEOUT_DEFAULT);
    expect(timeoutOf(0)).toBe(TIMEOUT_MIN);
    expect(timeoutOf(60_000)).toBe(60_000);
    expect(timeoutOf(3_600_000)).toBe(TIMEOUT_MAX);
  });
});

describe('clientDataJSON (extension.md §7.3)', () => {
  it('holds the type, the challenge and the reported origin, in order', () => {
    const json = new TextDecoder().decode(clientDataJSON(get('https://example.com')));
    expect(json).toBe(
      '{"type":"webauthn.get","challenge":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8","origin":"https://example.com","crossOrigin":false}',
    );
    const created = JSON.parse(
      new TextDecoder().decode(clientDataJSON(create('https://example.com'))),
    ) as Record<string, unknown>;
    expect(created.type).toBe('webauthn.create');
  });

  it('adds topOrigin in a frame of another origin', () => {
    const json = new TextDecoder().decode(
      clientDataJSON(get('https://pay.example', {}, 'https://shop.example')),
    );
    expect(JSON.parse(json)).toEqual({
      type: 'webauthn.get',
      challenge: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
      origin: 'https://pay.example',
      crossOrigin: true,
      topOrigin: 'https://shop.example',
    });
    expect(json.endsWith('"crossOrigin":true,"topOrigin":"https://shop.example"}')).toBe(true);
  });
});

const id = (n: number) => Uint8Array.from({ length: 16 }, (_, i) => (i === 15 ? n : 0));

function passkey(rpId: string, credential: number, user: number, userName?: string): PasskeyValue {
  return {
    privateKey: new Uint8Array(48),
    credentialId: Uint8Array.of(credential),
    rpId,
    userHandle: Uint8Array.of(user),
    ...(userName === undefined ? {} : { userName }),
    createdAt: 0,
  };
}

function item(n: number, title: string, fields: Field[], extra: Partial<ItemView> = {}): ItemView {
  return {
    id: id(n),
    hlc: {} as never,
    inTrash: false,
    item: { templateId: 'login', templateVersion: 1, title, fields, tags: [] },
    ...extra,
  };
}

const field = (value: PasskeyValue): Field => ({ type: 'passkey', value });
const URL_FIELD: Field = { type: 'url', role: 'url', value: 'https://example.com' };

const MAIL = item(1, 'Mail', [URL_FIELD, field(passkey('example.com', 1, 10, 'ana'))]);
const COPY = item(2, 'Mail copy', [field(passkey('example.com', 1, 10, 'ana'))]);
const WORK = item(3, 'Work', [URL_FIELD, field(passkey('example.com', 2, 20))]);
const OTHER = item(4, 'Other', [field(passkey('other.com', 3, 10))]);
const TRASHED = item(5, 'Old', [URL_FIELD, field(passkey('example.com', 4, 10))], {
  inTrash: true,
});
const NEWER: ItemView = { id: id(6), hlc: {} as never, inTrash: false, readOnly: 'newer-content' };
const READ_ONLY = item(7, 'Frozen', [URL_FIELD], { readOnly: 'future-clock' });
const NOTE: ItemView = {
  ...item(8, 'Note', [URL_FIELD]),
  item: {
    templateId: 'secure-note',
    templateVersion: 1,
    title: 'Note',
    fields: [URL_FIELD],
    tags: [],
  },
};
const ITEMS = [MAIL, COPY, WORK, OTHER, TRASHED, NEWER, READ_ONLY, NOTE];

describe('candidates (extension.md §7.4)', () => {
  it('lists the passkeys of the rpId outside the trash, each credentialId once', () => {
    const found = candidates(ITEMS, 'example.com');
    expect(found.map((c) => [c.credentialId, c.title, c.userName])).toEqual([
      ['01', 'Mail', 'ana'],
      ['02', 'Work', undefined],
    ]);
  });

  it('keeps those allowCredentials lists, and none of another rpId', () => {
    const allow = [{ type: 'public-key', id: Uint8Array.of(2) }];
    expect(candidates(ITEMS, 'example.com', allow).map((c) => c.credentialId)).toEqual(['02']);
    expect(candidates(ITEMS, 'example.com', [{ type: 'other', id: Uint8Array.of(2) }])).toEqual([]);
    expect(candidates(ITEMS, 'other.com', allow)).toEqual([]);
    expect(candidates(ITEMS, 'nothing.example')).toEqual([]);
  });
});

describe('the create side (extension.md §7.4)', () => {
  it('finds a held credentialId of excludeCredentials, never one in the trash', () => {
    const listing = (n: number) => [{ type: 'public-key', id: Uint8Array.of(n) }];
    expect(holdsExcluded(ITEMS, 'example.com', listing(2))).toBe(true);
    expect(holdsExcluded(ITEMS, 'example.com', listing(4))).toBe(false);
    expect(holdsExcluded(ITEMS, 'example.com', [])).toBe(false);
  });

  it('finds only a credentialId of the create’s rpId, so a site learns nothing of another (P-01)', () => {
    const other = [{ type: 'public-key', id: Uint8Array.of(3) }];
    expect(holdsExcluded(ITEMS, 'other.com', other)).toBe(true);
    expect(holdsExcluded(ITEMS, 'example.com', other)).toBe(false);
  });

  it('finds every item holding the rpId and userHandle', () => {
    expect(holders(ITEMS, 'example.com', Uint8Array.of(10)).map((v) => v.item.title)).toEqual([
      'Mail',
      'Mail copy',
    ]);
    expect(holders(ITEMS, 'example.com', Uint8Array.of(99))).toEqual([]);
  });

  it('saves into writable Login items that match the origin, by title', () => {
    expect(saveTargets(ITEMS, 'https://example.com').map((v) => v.item.title)).toEqual([
      'Mail',
      'Work',
    ]);
    expect(saveTargets(ITEMS, 'https://login.example.com')).toEqual([]);
  });

  it('replaces the passkey of the same rpId and userHandle in place, or adds it', () => {
    const next = passkey('example.com', 9, 10, 'ana');
    const mail = MAIL.item;
    const work = WORK.item;
    if (!mail || !work) throw new Error('fixture');
    expect(withPasskey(mail, next).fields).toEqual([URL_FIELD, field(next)]);
    expect(withPasskey(work, next).fields).toEqual([...work.fields, field(next)]);
  });
});
