import { describe, expect, it, vi } from 'vitest';

import {
  type PopupRuntime,
  copy,
  fill,
  matches,
  onLocked,
  openHost,
  search,
  status,
} from './popup-client';

type Listener = Parameters<PopupRuntime['onMessage']['addListener']>[0];

/** A runtime whose session host answers with `reply(request)`. */
function runtime(reply: (request: Record<string, unknown>) => unknown) {
  let listener: Listener | undefined;
  const sent = vi.fn((m: Record<string, unknown>) => Promise.resolve(reply(m)));
  const r: PopupRuntime = {
    id: 'abc',
    getURL: (path) => `chrome-extension://abc/${path}`,
    sendMessage: sent,
    onMessage: {
      addListener: (l) => {
        listener = l;
      },
    },
  };
  return {
    r,
    sent,
    hear: (message: unknown, url: string) => listener?.(message, { id: 'abc', url }),
  };
}

const ok = (m: Record<string, unknown>, rest: object) => ({ v: 1, id: m.id, ok: true, ...rest });

describe('the popup’s messages (extension.md §4, D286)', () => {
  it('reads the vault’s state, and no answer as locked', async () => {
    await expect(status(runtime((m) => ok(m, { state: 'unlocked' })).r)).resolves.toBe('unlocked');
    await expect(status(runtime((m) => ok(m, { state: 'locked' })).r)).resolves.toBe('locked');
    const none = runtime(() => undefined);
    none.sent.mockRejectedValue(new Error('Receiving end does not exist.'));
    await expect(status(none.r)).resolves.toBe('locked');
  });

  it('ignores an answer to another request', async () => {
    const { r } = runtime((m) => ({ v: 1, id: (m.id as number) + 1, ok: true, state: 'unlocked' }));
    await expect(status(r)).resolves.toBe('locked');
  });

  it('sends a search and reads the items', async () => {
    const items = [
      { itemId: 'a'.repeat(32), title: 'Mail', username: 'ana', fields: ['password'] },
    ];
    const { r, sent } = runtime((m) => ok(m, { items }));
    await expect(search(r, 'mail')).resolves.toEqual(items);
    expect(sent).toHaveBeenCalledWith({
      v: 1,
      id: expect.any(Number) as unknown,
      type: 'search',
      query: 'mail',
    });
  });

  it('refuses a malformed item list', async () => {
    const bad = [{ itemId: 'a', title: 'Mail', fields: ['notes'] }];
    await expect(search(runtime((m) => ok(m, { items: bad })).r, '')).resolves.toBeUndefined();
  });

  it('reads a copy and a refusal', async () => {
    const { r } = runtime((m) => ok(m, { value: 'hunter2', clearSeconds: 30 }));
    await expect(copy(r, 'a'.repeat(32), 'password')).resolves.toEqual({
      value: 'hunter2',
      clearSeconds: 30,
    });
    const refused = runtime((m) => ({ v: 1, id: m.id, ok: false, error: 'locked' }));
    await expect(copy(refused.r, 'a'.repeat(32), 'password')).resolves.toBe('locked');
  });

  it('asks the matching items of a tab, and reads why none can match', async () => {
    const items = [
      { itemId: 'a'.repeat(32), title: 'Mail', fields: ['password'], url: 'mail.example.com' },
    ];
    const { r, sent } = runtime((m) => ok(m, { items }));
    await expect(matches(r, 12)).resolves.toEqual(items);
    expect(sent).toHaveBeenCalledWith({
      v: 1,
      id: expect.any(Number) as unknown,
      type: 'matches',
      tabId: 12,
    });
    const page = runtime((m) => ({ v: 1, id: m.id, ok: false, error: 'page' }));
    await expect(matches(page.r, 12)).resolves.toBe('page');
  });

  it('refuses a match with no URL', async () => {
    const bad = [{ itemId: 'a'.repeat(32), title: 'Mail', fields: ['password'] }];
    await expect(matches(runtime((m) => ok(m, { items: bad })).r, 1)).resolves.toBeUndefined();
  });

  it('asks a fill, and reads its refusal', async () => {
    const { r, sent } = runtime((m) => ok(m, {}));
    await expect(fill(r, 12, 'a'.repeat(32))).resolves.toBe(true);
    expect(sent).toHaveBeenCalledWith({
      v: 1,
      id: expect.any(Number) as unknown,
      type: 'fill',
      tabId: 12,
      itemId: 'a'.repeat(32),
    });
    for (const error of ['no-target', 'moved', 'no-match']) {
      const refused = runtime((m) => ({ v: 1, id: m.id, ok: false, error }));
      await expect(fill(refused.r, 12, 'a'.repeat(32))).resolves.toBe(error);
    }
    const unknown = runtime((m) => ({ v: 1, id: m.id, ok: false, error: 'other' }));
    await expect(fill(unknown.r, 12, 'a'.repeat(32))).resolves.toBeUndefined();
  });

  it('asks the service worker to open the session host', async () => {
    const { r, sent } = runtime((m) => ok(m, {}));
    await openHost(r);
    expect(sent).toHaveBeenCalledWith({
      v: 1,
      id: expect.any(Number) as unknown,
      type: 'open-host',
    });
  });

  it('closes on the session host’s lock, and on no one else’s', () => {
    const { r, hear } = runtime(() => undefined);
    const closed = vi.fn();
    onLocked(r, closed);
    hear({ v: 1, type: 'locked', id: 0 }, 'https://example.com/');
    hear({ v: 1, type: 'locked', id: 0 }, 'chrome-extension://abc/background.js');
    hear({ v: 1, type: 'locked', id: 0, x: 1 }, 'chrome-extension://abc/index.html');
    expect(closed).not.toHaveBeenCalled();
    hear({ v: 1, type: 'locked', id: 0 }, 'chrome-extension://abc/index.html');
    expect(closed).toHaveBeenCalledTimes(1);
  });
});
