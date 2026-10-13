import { describe, expect, it, vi } from 'vitest';

import { UpdateMonitor, type WatchedRegistration } from './updates';

const HASH = 'ab'.repeat(32);

/** A registration whose active worker answers each message with `reply(message)`. */
class FakeRegistration implements WatchedRegistration {
  active: { postMessage: (message: unknown, transfer: Transferable[]) => void } | null;
  installing: object | null = null;
  waiting: object | null = null;
  readonly sent: unknown[] = [];
  readonly update = vi.fn(() => Promise.resolve());
  #found: (() => void) | undefined;

  constructor(reply: (message: unknown) => unknown = () => ({ type: 'none' })) {
    this.active = {
      postMessage: (message, transfer) => {
        this.sent.push(message);
        const answer = reply(message);
        if (answer !== undefined) (transfer[0] as MessagePort).postMessage(answer);
      },
    };
  }

  addEventListener(_type: 'updatefound', listener: () => void): void {
    this.#found = listener;
  }

  /** The browser found a changed sw.js. */
  found(): void {
    this.#found?.();
  }
}

function monitor(options: { allowed?: () => boolean; timeoutMs?: number } = {}) {
  const calls: string[] = [];
  const m = new UpdateMonitor({
    lock: () => calls.push('lock'),
    reload: () => calls.push('reload'),
    allowed: options.allowed ?? (() => true),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return { m, calls };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 1));
};

describe('changed sw.js (D63, D142, D162, D191)', () => {
  it('locks synchronously in the updatefound handler while a worker is active, then warns', () => {
    const { m, calls } = monitor();
    const r = new FakeRegistration();
    m.watch(r);
    expect(calls).toEqual([]);
    r.found();
    // No await between the event and the lock.
    expect(calls).toEqual(['lock']);
    expect(m.getState()).toMatchObject({ changedWorker: true, warning: true });
  });

  it('does not take the first install of a service worker for a change', () => {
    const { m, calls } = monitor();
    const r = new FakeRegistration();
    r.active = null;
    m.watch(r);
    r.found();
    expect(calls).toEqual([]);
    expect(m.getState().warning).toBe(false);
  });

  it.each(['installing', 'waiting'] as const)(
    'takes a worker %s next to the active one when watched for a change',
    (state) => {
      const { m, calls } = monitor();
      const r = new FakeRegistration();
      r[state] = {};
      m.watch(r);
      expect(calls).toEqual(['lock']);
      expect(m.getState().warning).toBe(true);
    },
  );

  it('keeps the change known once the warning is dismissed, and offers no update', async () => {
    const { m } = monitor();
    const r = new FakeRegistration(() => ({ type: 'available', version: '2.0.0', hash: HASH }));
    m.watch(r);
    r.found();
    m.acknowledge();
    expect(m.getState()).toMatchObject({ changedWorker: true, warning: false });
    m.look();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(r.sent).toEqual([]);
    expect(m.getState().offer).toBeUndefined();
    expect(await m.apply()).toBe('refused');
  });
});

describe('asset update offer (D63, D162, D191)', () => {
  it('looks for a changed sw.js and an asset update, and offers what the worker staged', async () => {
    const { m } = monitor();
    const r = new FakeRegistration(() => ({ type: 'available', version: '2.0.0', hash: HASH }));
    m.watch(r);
    const seen: unknown[] = [];
    m.subscribe(() => seen.push(m.getState().offer));
    m.look();
    expect(r.update).toHaveBeenCalledOnce();
    await until(() => m.getState().offer !== undefined);
    expect(r.sent).toEqual([{ type: 'check' }]);
    expect(m.getState().offer).toEqual({ version: '2.0.0', hash: HASH });
    expect(seen).toHaveLength(1);
  });

  it.each([
    ['no update', { type: 'none' }],
    ['a short hash', { type: 'available', version: '2.0.0', hash: 'ab' }],
    ['an uppercase hash', { type: 'available', version: '2.0.0', hash: HASH.toUpperCase() }],
    ['a version with markup', { type: 'available', version: '<b>2</b>', hash: HASH }],
    ['no version', { type: 'available', hash: HASH }],
    ['garbage', 'available'],
  ])('offers nothing for %s', async (_, reply) => {
    const { m } = monitor();
    const r = new FakeRegistration(() => reply);
    m.watch(r);
    m.look();
    await until(() => r.sent.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(m.getState().offer).toBeUndefined();
  });

  it('does nothing before a registration, or without an active worker', () => {
    const { m } = monitor();
    m.look();
    const r = new FakeRegistration();
    r.active = null;
    m.watch(r);
    m.look();
    expect(r.update).toHaveBeenCalledOnce();
    expect(r.sent).toEqual([]);
  });

  it('survives a failed update() and a worker that never answers', async () => {
    const { m } = monitor({ timeoutMs: 5 });
    const r = new FakeRegistration(() => undefined);
    r.update.mockImplementation(() => Promise.reject(new TypeError('offline')));
    m.watch(r);
    m.look();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(m.getState().offer).toBeUndefined();
  });
});

describe('applying an asset update (D152, D191)', () => {
  async function offered(apply: unknown, options: Parameters<typeof monitor>[0] = {}) {
    const { m, calls } = monitor(options);
    const r = new FakeRegistration((message) =>
      (message as { type: string }).type === 'check'
        ? { type: 'available', version: '2.0.0', hash: HASH }
        : apply,
    );
    m.watch(r);
    m.look();
    await until(() => m.getState().offer !== undefined);
    return { m, calls, r };
  }

  it('locks before asking the worker for that hash, and reloads once applied', async () => {
    const { m, calls, r } = await offered({ type: 'applied' });
    const active = r.active;
    if (!active) throw new Error('no active worker');
    const post = active.postMessage.bind(active);
    active.postMessage = (message, transfer) => {
      calls.push('sent');
      post(message, transfer);
    };
    calls.length = 0;
    expect(await m.apply()).toBe('applied');
    expect(calls).toEqual(['lock', 'sent', 'reload']);
    expect(r.sent[1]).toEqual({ type: 'apply', hash: HASH });
  });

  it.each([
    ['refuses', { type: 'refused' }],
    ['answers garbage', 'applied'],
    ['never answers', undefined],
  ])('reloads nothing and drops the offer when the worker %s', async (_, reply) => {
    const { m, calls } = await offered(reply, { timeoutMs: 20 });
    calls.length = 0;
    expect(await m.apply()).toBe('refused');
    expect(calls).toEqual(['lock']);
    expect(m.getState().offer).toBeUndefined();
  });

  it('touches nothing while a flow is in progress, or with nothing offered', async () => {
    let allowed = true;
    const { m, calls, r } = await offered({ type: 'applied' }, { allowed: () => allowed });
    allowed = false;
    calls.length = 0;
    expect(await m.apply()).toBe('refused');
    expect(calls).toEqual([]);
    expect(r.sent).toHaveLength(1);
    const empty = monitor();
    expect(await empty.m.apply()).toBe('refused');
    expect(empty.calls).toEqual([]);
  });
});
