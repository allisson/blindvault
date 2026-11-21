import { type Field, type ItemView, type VaultSession } from '@blindvault/vault';
import { describe, expect, it, vi } from 'vitest';

import { type TabsPort } from './fill';
import {
  type HostApp,
  type HostRuntime,
  answer,
  matchingLogins,
  searchLogins,
  serveHost,
} from './host';
import { type InPageOrder } from './inject';
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

function app(unlocked = true, items: readonly ItemView[] = ITEMS) {
  const session = {
    items: () => items,
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

/** A tab showing `url`, whose top frame has a password field; `fillResult` is the fill's answer. */
function tabsAt(url: string | undefined, fillResult: unknown = 'filled') {
  const orders: InPageOrder[] = [];
  const port: TabsPort = {
    url: () => Promise.resolve(url),
    run: (_tabId, _frames, order) => {
      orders.push(order);
      if (order.kind === 'fill') return Promise.resolve([{ frameId: 0, result: fillResult }]);
      const origin = url === undefined ? '' : new URL(url).origin;
      return Promise.resolve([
        {
          frameId: 0,
          result: { origin, password: true, focusedPassword: false, focusedText: false },
        },
      ]);
    },
  };
  return { port, orders };
}

function deps(a = app(), tabs: TabsPort | undefined = tabsAt('https://mail.example.com/').port) {
  return { app: a, activity: vi.fn(), copied: vi.fn(), now: () => 59_000, tabs };
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

describe('matchingLogins (extension.md §5, D287)', () => {
  it('lists the Login items that match, with the URL that matched, never a trashed one', () => {
    expect(matchingLogins(ITEMS, 'https://mail.example.com/inbox')).toEqual([
      {
        itemId: hexOf(1),
        title: 'Mail',
        username: 'ana@example.com',
        fields: ['username', 'password', 'totp'],
        url: 'https://mail.example.com',
      },
    ]);
    expect(matchingLogins(ITEMS, 'https://bank.example/')).toMatchObject([
      { title: 'Bank', url: 'bank.example' },
    ]);
    expect(matchingLogins(ITEMS, 'https://www.bank.example/')).toEqual([]);
  });
});

describe('answer, filling (extension.md §6, D287)', () => {
  it('answers the matching items of the tab’s page, read from the browser', async () => {
    await expect(
      answer(req({ type: 'matches', tabId: 3 } as never), deps()),
    ).resolves.toMatchObject({ ok: true, items: [{ title: 'Mail' }] });
  });

  it.each([
    ['a page on http', 'http://mail.example.com/'],
    ['an extension page', 'chrome-extension://abc/index.html'],
    ['a tab whose URL the browser does not give', undefined],
  ])('answers that %s cannot match', async (_name, url) => {
    await expect(
      answer(req({ type: 'matches', tabId: 3 } as never), deps(app(), tabsAt(url).port)),
    ).resolves.toEqual({ v: 1, id: 7, ok: false, error: 'page' });
  });

  it('answers page with no browser tabs to read', async () => {
    await expect(
      answer(req({ type: 'matches', tabId: 3 } as never), { ...deps(), tabs: undefined }),
    ).resolves.toMatchObject({ ok: false, error: 'page' });
  });

  it('fills the user name and the password into the tab, with its top frame’s origin', async () => {
    const tabs = tabsAt('https://mail.example.com/login');
    await expect(
      answer(req({ type: 'fill', tabId: 3, itemId: hexOf(1) } as never), deps(app(), tabs.port)),
    ).resolves.toEqual({ v: 1, id: 7, ok: true });
    expect(tabs.orders).toEqual([
      { kind: 'probe' },
      {
        kind: 'fill',
        origin: 'https://mail.example.com',
        username: 'ana@example.com',
        password: 'hunter2',
      },
    ]);
  });

  it('refuses to fill an item that does not match the tab, writing nothing', async () => {
    const tabs = tabsAt('https://mail.example.com/');
    await expect(
      answer(req({ type: 'fill', tabId: 3, itemId: hexOf(2) } as never), deps(app(), tabs.port)),
    ).resolves.toEqual({ v: 1, id: 7, ok: false, error: 'no-match' });
    expect(tabs.orders).toEqual([]);
  });

  it.each([
    ['a trashed item', hexOf(3), 'https://mail.example.com/', 'not-found'],
    ['an unknown item', hexOf(9), 'https://mail.example.com/', 'not-found'],
    ['a page that cannot match', hexOf(1), 'http://mail.example.com/', 'page'],
  ])('refuses to fill %s', async (_name, itemId, url, error) => {
    const tabs = tabsAt(url);
    await expect(
      answer(req({ type: 'fill', tabId: 3, itemId } as never), deps(app(), tabs.port)),
    ).resolves.toMatchObject({ ok: false, error });
    expect(tabs.orders).toEqual([]);
  });

  it('refuses an item with nothing to fill', async () => {
    const bare = login(8, 'Bare', [
      { type: 'url', role: 'url', value: 'https://mail.example.com' },
    ]);
    await expect(
      answer(req({ type: 'fill', tabId: 3, itemId: hexOf(8) } as never), deps(app(true, [bare]))),
    ).resolves.toMatchObject({ ok: false, error: 'no-field' });
  });

  it('reports a page that navigated, and one with no sign-in field', async () => {
    const r = req({ type: 'fill', tabId: 3, itemId: hexOf(1) } as never);
    const url = 'https://mail.example.com/';
    await expect(answer(r, deps(app(), tabsAt(url, 'moved').port))).resolves.toMatchObject({
      error: 'moved',
    });
    await expect(answer(r, deps(app(), tabsAt(url, 'no-target').port))).resolves.toMatchObject({
      error: 'no-target',
    });
  });

  it('refuses matches and fill while the vault is locked', async () => {
    const d = deps(app(false));
    await expect(answer(req({ type: 'matches', tabId: 3 } as never), d)).resolves.toMatchObject({
      error: 'locked',
    });
    await expect(
      answer(req({ type: 'fill', tabId: 3, itemId: hexOf(1) } as never), d),
    ).resolves.toMatchObject({ error: 'locked' });
  });
});

describe('answer, the shortcut (extension.md §6.2)', () => {
  const command = req({ type: 'command-fill', tabId: 3 } as never);

  it('fills when exactly one item matches', async () => {
    const tabs = tabsAt('https://mail.example.com/');
    await expect(answer(command, deps(app(), tabs.port))).resolves.toEqual({
      v: 1,
      id: 7,
      ok: true,
      result: 'filled',
    });
    expect(tabs.orders.map((o) => o.kind)).toEqual(['probe', 'fill']);
  });

  it('opens the popup when several match, none matches, or the vault is locked', async () => {
    const twin = login(8, 'Mail too', [
      { type: 'secret', role: 'password', value: 'p' },
      { type: 'url', role: 'url', value: 'https://mail.example.com' },
    ]);
    const several = tabsAt('https://mail.example.com/');
    await expect(
      answer(command, deps(app(true, [MAIL, twin]), several.port)),
    ).resolves.toMatchObject({ result: 'popup' });
    expect(several.orders).toEqual([]);
    await expect(
      answer(command, deps(app(), tabsAt('https://nothing.example/').port)),
    ).resolves.toMatchObject({ result: 'popup' });
    await expect(answer(command, deps(app(false)))).resolves.toMatchObject({ result: 'popup' });
  });

  it('opens the popup when the page has no sign-in field', async () => {
    await expect(
      answer(command, deps(app(), tabsAt('https://mail.example.com/', 'no-target').port)),
    ).resolves.toMatchObject({ result: 'popup' });
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
const WORKER = 'chrome-extension://abc/background.js';

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
    send({ v: 1, type: 'lock', id: 0 }, WORKER);
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

  it.each([
    ['command-fill from the popup', { v: 1, type: 'command-fill', id: 2, tabId: 3 }, POPUP],
    [
      'fill from the service worker',
      { v: 1, type: 'fill', id: 2, tabId: 3, itemId: hexOf(1) },
      WORKER,
    ],
    ['matches from the service worker', { v: 1, type: 'matches', id: 2, tabId: 3 }, WORKER],
    [
      'copy from the service worker',
      { v: 1, type: 'copy', id: 2, itemId: hexOf(1), field: 'password' },
      WORKER,
    ],
  ])('refuses %s, acting on nothing', (_name, message, url) => {
    const { r, send } = runtime();
    const tabs = tabsAt('https://mail.example.com/');
    const d = deps(app(), tabs.port);
    serveHost(r, d);
    const { respond, kept } = send(message, url);
    expect(kept).toBe(false);
    expect(respond).toHaveBeenCalledWith({ v: 1, id: 2, ok: false, error: 'invalid' });
    expect(tabs.orders).toEqual([]);
    expect(d.copied).not.toHaveBeenCalled();
    expect(d.activity).not.toHaveBeenCalled();
  });

  it('ignores a fill from a content script, whose sender is the web page', () => {
    const { r, send } = runtime();
    const tabs = tabsAt('https://mail.example.com/');
    serveHost(r, deps(app(), tabs.port));
    const { respond, kept } = send(
      { v: 1, type: 'fill', id: 2, tabId: 3, itemId: hexOf(1) },
      'https://mail.example.com/login',
    );
    expect(kept).toBe(false);
    expect(respond).not.toHaveBeenCalled();
    expect(tabs.orders).toEqual([]);
  });

  it('takes command-fill from the service worker', async () => {
    const { r, send } = runtime();
    serveHost(r, deps());
    const { respond } = send({ v: 1, type: 'command-fill', id: 0, tabId: 3 }, WORKER);
    await vi.waitFor(() => {
      expect(respond).toHaveBeenCalledWith({ v: 1, id: 0, ok: true, result: 'filled' });
    });
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
