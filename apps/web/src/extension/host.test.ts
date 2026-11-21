import { type Field, type ItemView, type VaultSession } from '@blindvault/vault';
import { describe, expect, it, vi } from 'vitest';

import { type HostApp, type HostRuntime, answer, searchLogins, serveHost } from './host';
import { type Request, SEARCH_MAX } from './rpc';

function id(n: number): Uint8Array {
  return Uint8Array.from({ length: 16 }, (_, i) => (i === 15 ? n : 0));
}
const hexOf = (n: number) => `${'0'.repeat(30)}${n.toString(16).padStart(2, '0')}`;

const TOTP = { secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30 } as const;

function login(n: number, title: string, fields: Field[], extra: Partial<ItemView> = {}): ItemView {
  return {
    id: id(n),
    hlc: {} as never,
    inTrash: false,
    item: { templateId: 'login', templateVersion: 1, title, fields, tags: [] },
    ...extra,
  };
}

const MAIL = login(1, 'Mail', [
  { type: 'text', role: 'username', value: 'ana@example.com' },
  { type: 'secret', role: 'password', value: 'hunter2' },
  { type: 'url', role: 'url', value: 'https://mail.example.com' },
  { type: 'totp', value: TOTP },
]);
const BANK = login(2, 'Bank', [
  { type: 'secret', role: 'password', value: 'b4nk' },
  { type: 'url', role: 'url', value: 'bank.example' },
]);
const TRASHED = login(3, 'Old mail', [{ type: 'secret', role: 'password', value: 'x' }], {
  inTrash: true,
});
const NOTE: ItemView = {
  id: id(4),
  hlc: {} as never,
  inTrash: false,
  item: {
    templateId: 'secure-note',
    templateVersion: 1,
    title: 'Mail note',
    fields: [{ type: 'secret', role: 'password', value: 'n' }],
    tags: [],
  },
};
const NEWER: ItemView = { id: id(5), hlc: {} as never, inTrash: false, readOnly: 'newer-content' };
const EMPTY_PASSWORD = login(6, 'Empty', [{ type: 'secret', role: 'password', value: '' }]);
const ITEMS = [MAIL, BANK, TRASHED, NOTE, NEWER, EMPTY_PASSWORD];

function app(unlocked = true) {
  const session = {
    items: () => ITEMS,
    preferences: { clipboardClearSeconds: 45 },
  } as unknown as VaultSession;
  const locks = vi.fn();
  const a: HostApp & { status: HostApp['status'] } = {
    status: unlocked ? { kind: 'unlocked', session } : { kind: 'locked' },
    lock: locks,
    subscribe: () => () => undefined,
  };
  return Object.assign(a, { locks });
}

function deps(a = app()) {
  return { app: a, activity: vi.fn(), copied: vi.fn(), now: () => 59_000 };
}

describe('searchLogins (D286)', () => {
  it('finds Login items by title, user name or URL, never by a secret', () => {
    expect(searchLogins(ITEMS, 'mail').map((f) => f.title)).toEqual(['Mail']);
    expect(searchLogins(ITEMS, 'ANA@').map((f) => f.title)).toEqual(['Mail']);
    expect(searchLogins(ITEMS, 'bank.example').map((f) => f.title)).toEqual(['Bank']);
    expect(searchLogins(ITEMS, 'hunter2')).toEqual([]);
    expect(searchLogins(ITEMS, 'JBSWY3DP')).toEqual([]);
  });

  it('lists every Login item outside the trash for an empty query, in title order', () => {
    expect(searchLogins(ITEMS, '  ')).toEqual([
      { itemId: hexOf(2), title: 'Bank', fields: ['password'] },
      { itemId: hexOf(6), title: 'Empty', fields: [] },
      {
        itemId: hexOf(1),
        title: 'Mail',
        username: 'ana@example.com',
        fields: ['username', 'password', 'totp'],
      },
    ]);
  });

  it('needs every term', () => {
    expect(searchLogins(ITEMS, 'mail ana').map((f) => f.title)).toEqual(['Mail']);
    expect(searchLogins(ITEMS, 'mail bank')).toEqual([]);
  });

  it(`answers at most ${String(SEARCH_MAX)} items`, () => {
    const many = Array.from({ length: SEARCH_MAX + 5 }, (_, i) =>
      login(i, `Site ${String(i)}`, []),
    );
    expect(searchLogins(many, 'site')).toHaveLength(SEARCH_MAX);
  });
});

const req = (r: Omit<Request, 'v' | 'id'>): Request => ({ v: 1, id: 7, ...r }) as Request;

describe('answer (extension.md §4, §6.3)', () => {
  it('tells the vault’s state', async () => {
    await expect(answer(req({ type: 'status' }), deps())).resolves.toEqual({
      v: 1,
      id: 7,
      ok: true,
      state: 'unlocked',
    });
    await expect(answer(req({ type: 'status' }), deps(app(false)))).resolves.toMatchObject({
      state: 'locked',
    });
  });

  it('locks', async () => {
    const d = deps();
    await expect(answer(req({ type: 'lock' }), d)).resolves.toEqual({ v: 1, id: 7, ok: true });
    expect(d.app.locks).toHaveBeenCalledTimes(1);
  });

  it('copies a password and starts the clear’s timer', async () => {
    const d = deps();
    const r = req({ type: 'copy', itemId: hexOf(1), field: 'password' } as never);
    await expect(answer(r, d)).resolves.toEqual({
      v: 1,
      id: 7,
      ok: true,
      value: 'hunter2',
      clearSeconds: 45,
    });
    expect(d.copied).toHaveBeenCalledWith(45);
  });

  it('copies the user name, and the current TOTP code (RFC 6238 at 59 s)', async () => {
    const d = deps();
    await expect(
      answer(req({ type: 'copy', itemId: hexOf(1), field: 'username' } as never), d),
    ).resolves.toMatchObject({ value: 'ana@example.com' });
    const code = await answer(req({ type: 'copy', itemId: hexOf(1), field: 'totp' } as never), d);
    expect(code).toMatchObject({ ok: true, value: expect.stringMatching(/^\d{6}$/) as unknown });
  });

  it.each([
    ['a trashed item', hexOf(3), 'password', 'not-found'],
    ['an item not a Login', hexOf(4), 'password', 'not-found'],
    ['an item of a newer app', hexOf(5), 'password', 'not-found'],
    ['an unknown item', hexOf(9), 'password', 'not-found'],
    ['a field the item lacks', hexOf(2), 'username', 'no-field'],
    ['an empty password', hexOf(6), 'password', 'no-field'],
  ])('refuses to copy from %s', async (_name, itemId, field, error) => {
    const d = deps();
    await expect(answer(req({ type: 'copy', itemId, field } as never), d)).resolves.toEqual({
      v: 1,
      id: 7,
      ok: false,
      error,
    });
    expect(d.copied).not.toHaveBeenCalled();
  });

  it('answers nothing of the vault while it is locked', async () => {
    const d = deps(app(false));
    await expect(answer(req({ type: 'search', query: '' } as never), d)).resolves.toMatchObject({
      ok: false,
      error: 'locked',
    });
    await expect(
      answer(req({ type: 'copy', itemId: hexOf(1), field: 'password' } as never), d),
    ).resolves.toMatchObject({ ok: false, error: 'locked' });
  });
});

type Listener = Parameters<HostRuntime['onMessage']['addListener']>[0];

function runtime() {
  let listener: Listener | undefined;
  const sent = vi.fn(() => Promise.resolve());
  const r: HostRuntime = {
    id: 'abc',
    getURL: (path) => `chrome-extension://abc/${path}`,
    onMessage: {
      addListener: (l) => {
        listener = l;
      },
    },
    sendMessage: sent,
  };
  const send = (message: unknown, url: string) => {
    const respond = vi.fn();
    const kept = listener?.(message, { id: 'abc', url }, respond);
    return { respond, kept };
  };
  return { r, send, sent };
}

const POPUP = 'chrome-extension://abc/popup.html';

describe('serveHost (extension.md §4)', () => {
  it('answers the popup, and counts it as activity (D284)', async () => {
    const { r, send } = runtime();
    const d = deps();
    serveHost(r, d);
    const { respond, kept } = send({ v: 1, type: 'status', id: 2 }, POPUP);
    expect(kept).toBe(true);
    await vi.waitFor(() => {
      expect(respond).toHaveBeenCalledWith({ v: 1, id: 2, ok: true, state: 'unlocked' });
    });
    expect(d.activity).toHaveBeenCalledTimes(1);
  });

  it('takes a lock from the service worker, on Chrome and on Firefox', () => {
    const { r, send } = runtime();
    const d = deps();
    serveHost(r, d);
    send({ v: 1, type: 'lock', id: 0 }, 'chrome-extension://abc/background.js');
    send({ v: 1, type: 'lock', id: 0 }, 'chrome-extension://abc/_generated_background_page.html');
    expect(d.app.locks).toHaveBeenCalledTimes(2);
  });

  it('ignores a content script, whose sender is the web page', () => {
    const { r, send } = runtime();
    const d = deps();
    serveHost(r, d);
    const { respond, kept } = send(
      { v: 1, type: 'copy', id: 2, itemId: hexOf(1), field: 'password' },
      'https://example.com/',
    );
    expect(kept).toBe(false);
    expect(respond).not.toHaveBeenCalled();
    expect(d.copied).not.toHaveBeenCalled();
    expect(d.activity).not.toHaveBeenCalled();
  });

  it('refuses an invalid message with an error answer, and acts on nothing', () => {
    const { r, send } = runtime();
    const d = deps();
    serveHost(r, d);
    const { respond } = send({ v: 1, type: 'lock', id: 4, now: true }, POPUP);
    expect(respond).toHaveBeenCalledWith({ v: 1, id: 4, ok: false, error: 'invalid' });
    expect(d.app.locks).not.toHaveBeenCalled();
  });

  it('stays silent on the service worker’s messages', () => {
    const { r, send } = runtime();
    serveHost(r, deps());
    const { respond, kept } = send({ v: 1, type: 'open-host', id: 1 }, POPUP);
    expect(kept).toBe(false);
    expect(respond).not.toHaveBeenCalled();
  });

  it('leaves the answer to the session host from a second tab (§3.1)', () => {
    const { r, send } = runtime();
    const a = app(false);
    a.status = { kind: 'elsewhere' };
    const d = deps(a);
    serveHost(r, d);
    const { respond, kept } = send({ v: 1, type: 'status', id: 1 }, POPUP);
    expect(kept).toBe(false);
    expect(respond).not.toHaveBeenCalled();
  });

  it('tells the popup when the vault locks', () => {
    const { r, sent } = runtime();
    const listeners = new Set<() => void>();
    const a = {
      ...app(),
      subscribe: (l: () => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
    serveHost(r, deps(a));
    for (const l of listeners) l();
    expect(sent).not.toHaveBeenCalled();
    a.status = { kind: 'locked' };
    for (const l of listeners) l();
    expect(sent).toHaveBeenCalledWith({
      v: 1,
      type: 'locked',
      id: expect.any(Number) as unknown,
    });
  });
});
