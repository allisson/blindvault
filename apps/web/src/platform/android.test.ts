import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClipboardGuard } from '../app/clipboard';
import {
  androidClipboard,
  androidFiles,
  androidLockSignals,
  androidPlatform,
  FILE_CHUNK_BYTES,
} from './android';
import { type ShellObject, ShellRefusedError, androidShell, shellBridge } from './android-bridge';

afterEach(() => {
  vi.unstubAllGlobals();
});

type Message = Record<string, unknown>;

/**
 * A shell that records what the window sends, and answers through `respond`: an object is sent as
 * its JSON text, `undefined` sends nothing. `push` sends anything, as the shell would.
 */
function fakeShell(respond: (message: Message) => unknown = () => undefined) {
  const sent: Message[] = [];
  const listeners = new Set<(event: { data: unknown }) => void>();
  const push = (data: unknown): void => {
    for (const l of listeners) l({ data: typeof data === 'string' ? data : JSON.stringify(data) });
  };
  const shell: ShellObject = {
    postMessage: (text) => {
      const message = JSON.parse(text) as Message;
      sent.push(message);
      queueMicrotask(() => {
        const answer = respond(message);
        if (answer !== undefined) push(answer);
      });
    },
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
  };
  return { shell, sent, push, bridge: shellBridge(shell) };
}

const ok = (m: Message, fields: Message = {}) => ({ v: 1, id: m.id, ok: true, ...fields });
const no = (m: Message, error: string) => ({ v: 1, id: m.id, ok: false, error });

/** Whether `promise` is still pending once every queued task has run. */
async function pending(promise: Promise<unknown>): Promise<boolean> {
  const still = Symbol('pending');
  const raced = await Promise.race([
    promise.then(
      () => 'settled',
      () => 'settled',
    ),
    new Promise((resolve) => setTimeout(resolve, 0)).then(() => still),
  ]);
  return raced === still;
}

function decode(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

describe('the shell bridge (android.md §9)', () => {
  it('sends `{v: 1, type, id, ...}` with a new id each time and takes the answer of that id', async () => {
    const { sent, bridge } = fakeShell((m) => ok(m, { echo: m.type }));
    await expect(bridge.request('clipboard-clear')).resolves.toMatchObject({
      echo: 'clipboard-clear',
    });
    await expect(bridge.request('file-chunk', { data: 'AA==' })).resolves.toMatchObject({
      ok: true,
    });
    expect(sent).toEqual([
      { v: 1, type: 'clipboard-clear', id: 1 },
      { v: 1, type: 'file-chunk', id: 2, data: 'AA==' },
    ]);
  });

  it('never lets the fields replace `v`, `type` or `id`', async () => {
    const { sent, bridge } = fakeShell((m) => ok(m));
    await bridge.request('clipboard-clear', { v: 2, type: 'keystore-delete', id: 99 });
    expect(sent[0]).toEqual({ v: 1, type: 'clipboard-clear', id: 1 });
  });

  it.each(['invalid', 'cancelled', 'invalidated', 'unavailable', 'failed'])(
    'rejects with the shell’s `%s`',
    async (error) => {
      const { bridge } = fakeShell((m) => no(m, error));
      const refused = await bridge.request('clipboard-clear').catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(ShellRefusedError);
      expect((refused as ShellRefusedError).error).toBe(error);
    },
  );

  it.each([
    ['another id', (m: Message) => ({ v: 1, id: Number(m.id) + 1, ok: true })],
    ['another version', (m: Message) => ({ v: 2, id: m.id, ok: true })],
    ['no `ok`', (m: Message) => ({ v: 1, id: m.id })],
    ['an `ok` that is not a boolean', (m: Message) => ({ v: 1, id: m.id, ok: 'true' })],
    ['an unknown error', (m: Message) => no(m, 'busy')],
    ['an error beside `ok: true`', (m: Message) => ({ ...ok(m), error: 'cancelled' })],
    ['a refusal with another key', (m: Message) => ({ ...no(m, 'cancelled'), secret: 'AA' })],
    ['text that is not JSON', () => '{"v": 1,'],
    ['JSON that is not an object', () => '[1]'],
    ['null', () => 'null'],
  ])('ignores an answer with %s', async (_case, answer) => {
    const { bridge } = fakeShell(answer);
    expect(await pending(bridge.request('clipboard-clear'))).toBe(true);
  });

  it('ignores a second answer to a request already answered', async () => {
    const { push, bridge } = fakeShell((m) => ok(m, { first: true }));
    await expect(bridge.request('clipboard-clear')).resolves.toMatchObject({ first: true });
    const next = bridge.request('clipboard-clear');
    push({ v: 1, id: 1, ok: false, error: 'failed' });
    await expect(next).resolves.toMatchObject({ id: 2, first: true });
  });

  it('ignores a message that is not a string', async () => {
    const listeners: ((event: { data: unknown }) => void)[] = [];
    const bridge = shellBridge({
      postMessage: () => undefined,
      addEventListener: (_type, l) => listeners.push(l),
    });
    const request = bridge.request('clipboard-clear');
    for (const l of listeners) l({ data: { v: 1, id: 1, ok: true } });
    expect(await pending(request)).toBe(true);
  });

  it('reports each lifecycle state until unsubscribed, and ignores any other message', () => {
    const { push, bridge } = fakeShell();
    const seen: string[] = [];
    const stop = bridge.onLifecycle((state) => seen.push(state));
    push({ v: 1, type: 'lifecycle', state: 'hidden' });
    push({ v: 1, type: 'lifecycle', state: 'shown' });
    push({ v: 1, type: 'lifecycle', state: 'screen-off' });
    push({ v: 1, type: 'lifecycle', state: 'paused' });
    push({ v: 2, type: 'lifecycle', state: 'hidden' });
    push({ v: 1, type: 'lifecycle', state: 'hidden', extra: 1 });
    push({ v: 1, type: 'lifecycle' });
    push({ v: 1, type: 'locked', state: 'hidden' });
    stop();
    push({ v: 1, type: 'lifecycle', state: 'hidden' });
    expect(seen).toEqual(['hidden', 'shown', 'screen-off']);
  });

  it('finds the shell’s object only where the shell set it', () => {
    expect(androidShell()).toBeUndefined();
    vi.stubGlobal('blindvaultShell', { postMessage: () => undefined });
    expect(androidShell()).toBeUndefined();
    const shell = fakeShell().shell;
    vi.stubGlobal('blindvaultShell', shell);
    expect(androidShell()).toBe(shell);
  });
});

describe('the Android lock signals (android.md §4.2)', () => {
  function signals() {
    const s = fakeShell();
    const activity = new Set<() => void>();
    const page = {
      onActivity: (listener: () => void) => {
        activity.add(listener);
        return () => activity.delete(listener);
      },
    };
    return { ...s, lock: androidLockSignals(() => s.bridge, page), activity };
  }

  it('counts the app hidden from `onStop` to `onStart`, once per change', () => {
    const { push, lock } = signals();
    expect(lock.hidden()).toBe(false);
    const seen: boolean[] = [];
    const stop = lock.onHidden((hidden) => seen.push(hidden));
    push({ v: 1, type: 'lifecycle', state: 'hidden' });
    push({ v: 1, type: 'lifecycle', state: 'hidden' });
    expect(lock.hidden()).toBe(true);
    push({ v: 1, type: 'lifecycle', state: 'shown' });
    stop();
    push({ v: 1, type: 'lifecycle', state: 'hidden' });
    expect(seen).toEqual([true, false]);
    expect(lock.hidden()).toBe(true);
  });

  it('locks at once when the screen turns off, and only then', () => {
    const { push, lock } = signals();
    const system = vi.fn();
    const stop = lock.onSystemLock(system);
    push({ v: 1, type: 'lifecycle', state: 'hidden' });
    push({ v: 1, type: 'lifecycle', state: 'shown' });
    expect(system).not.toHaveBeenCalled();
    push({ v: 1, type: 'lifecycle', state: 'screen-off' });
    expect(system).toHaveBeenCalledTimes(1);
    stop();
    push({ v: 1, type: 'lifecycle', state: 'screen-off' });
    expect(system).toHaveBeenCalledTimes(1);
  });

  it('takes activity from input in the window', () => {
    const { lock, activity } = signals();
    const touched = vi.fn();
    const stop = lock.onActivity(touched);
    for (const l of activity) l();
    expect(touched).toHaveBeenCalledTimes(1);
    stop();
    expect(activity.size).toBe(0);
  });

  it('knows no lifecycle without the shell', () => {
    const lock = androidLockSignals(() => undefined, { onActivity: () => () => undefined });
    expect(lock.hidden()).toBe(false);
    lock.onHidden(() => undefined)();
    lock.onSystemLock(() => undefined)();
  });
});

describe('the Android clipboard (android.md §6.1)', () => {
  it('copies through the shell with the clear’s time, and clears through it', async () => {
    const { sent, bridge } = fakeShell((m) => ok(m));
    const port = androidClipboard(() => bridge);
    await port.write('s3cret', 30);
    await port.write('');
    expect(sent).toEqual([
      { v: 1, type: 'clipboard-copy', id: 1, text: 's3cret', clearSeconds: 30 },
      { v: 1, type: 'clipboard-clear', id: 2 },
    ]);
    expect(port.hasFocus()).toBe(true);
  });

  it('has the guard hand its time to the shell, and clear at once on lock', async () => {
    vi.useFakeTimers();
    try {
      const { sent, bridge } = fakeShell((m) => ok(m));
      const guard = new ClipboardGuard(androidClipboard(() => bridge));
      await guard.copy('s3cret', 45);
      guard.lock();
      expect(sent.map(({ type, clearSeconds }) => ({ type, clearSeconds }))).toEqual([
        { type: 'clipboard-copy', clearSeconds: 45 },
        { type: 'clipboard-clear', clearSeconds: undefined },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a copy with no clear time, and one the shell refuses', async () => {
    const { bridge } = fakeShell((m) => no(m, 'failed'));
    const port = androidClipboard(() => bridge);
    await expect(port.write('s3cret')).rejects.toThrow(RangeError);
    await expect(port.write('s3cret', 30)).rejects.toBeInstanceOf(ShellRefusedError);
  });

  it('copies nothing without the shell', async () => {
    await expect(androidClipboard(() => undefined).write('s3cret', 30)).rejects.toThrow(/shell/);
  });
});

describe('saving a file through the Android shell (android.md §6.2)', () => {
  const bytes = (n: number) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) out[i] = (i * 7) % 251;
    return out;
  };

  it('asks for the document, writes 1 MiB chunks in order, and closes it', async () => {
    const { sent, bridge } = fakeShell((m) => ok(m));
    const content = bytes(FILE_CHUNK_BYTES * 2 + 5);
    const files = androidFiles(() => bridge);
    await expect(
      files.save(new Blob([content], { type: 'application/octet-stream' }), 'b.bvault'),
    ).resolves.toBe('saved');
    expect(sent.map((m) => m.type)).toEqual([
      'file-save',
      'file-chunk',
      'file-chunk',
      'file-chunk',
      'file-end',
    ]);
    expect(sent[0]).toEqual({
      v: 1,
      type: 'file-save',
      id: 1,
      name: 'b.bvault',
      mediaType: 'application/octet-stream',
    });
    const chunks = sent.slice(1, 4).map((m) => decode(m.data as string));
    expect(chunks.map((c) => c.length)).toEqual([FILE_CHUNK_BYTES, FILE_CHUNK_BYTES, 5]);
    const joined = new Uint8Array(content.length);
    chunks.reduce((at, c) => {
      joined.set(c, at);
      return at + c.length;
    }, 0);
    expect(joined.findIndex((b, i) => b !== content[i])).toBe(-1);
    expect(FILE_CHUNK_BYTES).toBe(1024 * 1024);
  });

  it('names the media type `application/octet-stream` when the file has none, and sends no chunk when empty', async () => {
    const { sent, bridge } = fakeShell((m) => ok(m));
    await androidFiles(() => bridge).save(new Blob([]), 'empty');
    expect(sent.map((m) => m.type)).toEqual(['file-save', 'file-end']);
    expect(sent[0]?.mediaType).toBe('application/octet-stream');
  });

  it('writes nothing when the user cancels the picker', async () => {
    const { sent, bridge } = fakeShell((m) =>
      m.type === 'file-save' ? no(m, 'cancelled') : ok(m),
    );
    await expect(androidFiles(() => bridge).save(new Blob([bytes(10)]), 'a')).resolves.toBe(
      'cancelled',
    );
    expect(sent.map((m) => m.type)).toEqual(['file-save']);
  });

  it('aborts on lock: no chunk after it, and `file-abort` to the shell', async () => {
    const held: { files?: ReturnType<typeof androidFiles> } = {};
    const { sent, bridge } = fakeShell((m) => {
      // The vault locks while the first chunk is written.
      if (m.type === 'file-chunk' && m.id === 2) held.files?.lock();
      return ok(m);
    });
    const files = androidFiles(() => bridge);
    held.files = files;
    await expect(files.save(new Blob([bytes(FILE_CHUNK_BYTES * 3)]), 'a')).resolves.toBe(
      'cancelled',
    );
    expect(sent.map((m) => m.type)).toEqual(['file-save', 'file-chunk', 'file-abort']);
    files.lock();
    expect(sent).toHaveLength(3);
  });

  it('drops a save asked while another runs', async () => {
    const { sent, bridge } = fakeShell((m) => ok(m));
    const files = androidFiles(() => bridge);
    const first = files.save(new Blob([bytes(10)]), 'a');
    await expect(files.save(new Blob([bytes(10)]), 'b')).resolves.toBe('cancelled');
    await expect(first).resolves.toBe('saved');
    expect(sent.filter((m) => m.type === 'file-save')).toHaveLength(1);
    await expect(files.save(new Blob([bytes(10)]), 'c')).resolves.toBe('saved');
  });

  it('rejects when the shell fails a write, and saves again after it', async () => {
    let fail = true;
    const { bridge } = fakeShell((m) =>
      m.type === 'file-chunk' && fail ? no(m, 'failed') : ok(m),
    );
    const files = androidFiles(() => bridge);
    await expect(files.save(new Blob([bytes(10)]), 'a')).rejects.toBeInstanceOf(ShellRefusedError);
    fail = false;
    await expect(files.save(new Blob([bytes(10)]), 'a')).resolves.toBe('saved');
  });

  it('saves nothing without the shell', async () => {
    await expect(androidFiles(() => undefined).save(new Blob([]), 'a')).rejects.toThrow(/shell/);
  });
});

describe('the Android platform (android.md §2)', () => {
  it('starts no update flow (§10, D282)', () => {
    const monitor = { watch: vi.fn(), look: vi.fn() };
    androidPlatform.startUpdates(monitor as never, {
      idle: () => true,
      subscribe: () => () => true,
    });
    expect(androidPlatform.kind).toBe('android');
    expect(monitor.watch).not.toHaveBeenCalled();
    expect(monitor.look).not.toHaveBeenCalled();
  });
});
