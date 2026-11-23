import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClipboardGuard } from '../app/clipboard';
import {
  KeystoreCancelledError,
  KeystoreInvalidatedError,
  KeystoreUnavailableError,
} from '../app/keystore';
import { toBase64url } from '../extension/passkey-options';
import {
  androidClipboard,
  androidFiles,
  androidKeystore,
  androidLockSignals,
  androidPlatform,
  androidSigningCertificate,
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

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing');
  return value;
}

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

  it('asks the shell for the lifecycle once, on first use, and takes the state it answers (D293)', async () => {
    const s = fakeShell((m) =>
      m.type === 'lifecycle-watch' ? ok(m, { state: 'hidden' }) : undefined,
    );
    const lock = androidLockSignals(() => s.bridge, { onActivity: () => () => undefined });
    expect(s.sent).toEqual([]);
    const seen: boolean[] = [];
    lock.onHidden((hidden) => seen.push(hidden));
    lock.onSystemLock(() => undefined);
    expect(lock.hidden()).toBe(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(s.sent).toEqual([{ v: 1, type: 'lifecycle-watch', id: 1 }]);
    expect(lock.hidden()).toBe(true);
    expect(seen).toEqual([true]);
    s.push({ v: 1, type: 'lifecycle', state: 'shown' });
    expect(seen).toEqual([true, false]);
  });

  it.each([
    ['a state the window does not know', (m: Message) => ok(m, { state: 'screen-off' })],
    ['no state', (m: Message) => ok(m)],
    ['another key', (m: Message) => ok(m, { state: 'shown', extra: 1 })],
    ['a refusal', (m: Message) => no(m, 'invalid')],
  ])('keeps the state it had when the watch is answered with %s', async (_case, answer) => {
    const s = fakeShell(answer);
    const lock = androidLockSignals(() => s.bridge, { onActivity: () => () => undefined });
    const seen: boolean[] = [];
    lock.onHidden((hidden) => seen.push(hidden));
    s.push({ v: 1, type: 'lifecycle', state: 'hidden' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(s.sent).toHaveLength(1);
    expect(lock.hidden()).toBe(true);
    expect(seen).toEqual([true]);
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

describe('the Keystore KEK through the Android shell (android.md §5, §9, D292)', () => {
  const LOCAL = new Uint8Array(16).fill(7);
  const IV = new Uint8Array(12).fill(1);
  const SEALED = new Uint8Array(48).fill(2);
  const SECRET = new Uint8Array(32).fill(3);
  const b64 = toBase64url;

  it('names the key by `localConfigId` in every call, and decodes each answer', async () => {
    const { sent, bridge } = fakeShell((m) => {
      if (m.type === 'keystore-status') return ok(m, { available: true, strongBox: false });
      if (m.type === 'keystore-seal') {
        return ok(m, { iv: b64(IV), sealed: b64(SEALED), strongBox: true });
      }
      if (m.type === 'keystore-open') return ok(m, { secret: b64(SECRET) });
      return ok(m);
    });
    const keystore = androidKeystore(() => bridge);
    await expect(keystore.status(LOCAL)).resolves.toEqual({ available: true, strongBox: false });
    await expect(keystore.seal(LOCAL, SECRET)).resolves.toEqual({
      iv: IV,
      sealed: SEALED,
      strongBox: true,
    });
    await expect(keystore.open(LOCAL, IV, SEALED)).resolves.toEqual(SECRET);
    await expect(keystore.delete(LOCAL)).resolves.toBeUndefined();
    const id = b64(LOCAL);
    expect(sent).toEqual([
      { v: 1, type: 'keystore-status', id: 1, localConfigId: id },
      { v: 1, type: 'keystore-seal', id: 2, localConfigId: id, secret: b64(SECRET) },
      { v: 1, type: 'keystore-open', id: 3, localConfigId: id, iv: b64(IV), sealed: b64(SEALED) },
      { v: 1, type: 'keystore-delete', id: 4, localConfigId: id },
    ]);
  });

  it('takes a status without `strongBox` when the key does not exist', async () => {
    const { bridge } = fakeShell((m) => ok(m, { available: false }));
    await expect(androidKeystore(() => bridge).status(LOCAL)).resolves.toEqual({
      available: false,
    });
  });

  it('turns `cancelled`, `invalidated` and `unavailable` into their errors, and keeps any other refusal', async () => {
    for (const [error, type] of [
      ['cancelled', KeystoreCancelledError],
      ['invalidated', KeystoreInvalidatedError],
      ['unavailable', KeystoreUnavailableError],
      ['failed', ShellRefusedError],
      ['invalid', ShellRefusedError],
    ] as const) {
      const { bridge } = fakeShell((m) => no(m, error));
      await expect(androidKeystore(() => bridge).open(LOCAL, IV, SEALED)).rejects.toThrow(type);
    }
  });

  it.each([
    ['a status with no `available`', 'keystore-status', {}],
    ['a status whose `available` is not a boolean', 'keystore-status', { available: 'yes' }],
    [
      'a status whose `strongBox` is not a boolean',
      'keystore-status',
      { available: true, strongBox: 1 },
    ],
    ['a status with another key', 'keystore-status', { available: true, extra: 1 }],
    [
      'a seal with an 11-byte IV',
      'keystore-seal',
      { iv: b64(IV.subarray(1)), sealed: b64(SEALED), strongBox: true },
    ],
    [
      'a seal with a 47-byte ciphertext',
      'keystore-seal',
      { iv: b64(IV), sealed: b64(SEALED.subarray(1)), strongBox: true },
    ],
    ['a seal with no `strongBox`', 'keystore-seal', { iv: b64(IV), sealed: b64(SEALED) }],
    [
      'a seal in padded base64',
      'keystore-seal',
      { iv: `${b64(IV)}=`, sealed: b64(SEALED), strongBox: true },
    ],
    ['an open with a 31-byte secret', 'keystore-open', { secret: b64(SECRET.subarray(1)) }],
    ['an open with a 33-byte secret', 'keystore-open', { secret: b64(new Uint8Array(33)) }],
    ['an open whose secret is not text', 'keystore-open', { secret: 3 }],
    ['an open with another key', 'keystore-open', { secret: b64(SECRET), iv: b64(IV) }],
    ['a delete with a key', 'keystore-delete', { done: true }],
  ])('refuses %s', async (_name, type, fields) => {
    const { bridge } = fakeShell((m) => ok(m, fields));
    const keystore = androidKeystore(() => bridge);
    const calls: Readonly<Record<string, () => Promise<unknown>>> = {
      'keystore-status': () => keystore.status(LOCAL),
      'keystore-seal': () => keystore.seal(LOCAL, SECRET),
      'keystore-open': () => keystore.open(LOCAL, IV, SEALED),
      'keystore-delete': () => keystore.delete(LOCAL),
    };
    await expect(must(calls[type])()).rejects.toThrow(/malformed/);
  });

  it('calls nothing without the shell', async () => {
    await expect(androidKeystore(() => undefined).status(LOCAL)).rejects.toThrow(/shell/);
  });
});

describe('the signing certificate through the Android shell (android.md §10)', () => {
  const CERT = 'ab'.repeat(32);
  const info = { versionName: '1.0.0-rc.3', versionCode: 1_000_003, certSha256: CERT };

  it('asks `build-info` and takes its certificate hash', async () => {
    const { sent, bridge } = fakeShell((m) => ok(m, info));
    await expect(androidSigningCertificate(() => bridge)()).resolves.toBe(CERT);
    expect(sent).toEqual([{ v: 1, type: 'build-info', id: 1 }]);
  });

  it.each([
    ['no `certSha256`', { versionName: info.versionName, versionCode: info.versionCode }],
    ['an uppercase hash', { ...info, certSha256: CERT.toUpperCase() }],
    ['a 31-byte hash', { ...info, certSha256: CERT.slice(2) }],
    ['a hash with colons', { ...info, certSha256: CERT.match(/../g)?.join(':') }],
    ['a hash that is not text', { ...info, certSha256: 1 }],
    ['no `versionName`', { versionCode: info.versionCode, certSha256: CERT }],
    ['another key', { ...info, extra: 1 }],
  ])('answers no certificate for %s', async (_name, fields) => {
    const { bridge } = fakeShell((m) => ok(m, fields));
    await expect(androidSigningCertificate(() => bridge)()).resolves.toBeUndefined();
  });

  it('answers no certificate on a refusal or without the shell', async () => {
    const { bridge } = fakeShell((m) => no(m, 'failed'));
    await expect(androidSigningCertificate(() => bridge)()).resolves.toBeUndefined();
    await expect(androidSigningCertificate(() => undefined)()).resolves.toBeUndefined();
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
    expect(androidPlatform.keystore).toBeDefined();
    expect(androidPlatform.signingCertificate).toBeDefined();
    expect(monitor.watch).not.toHaveBeenCalled();
    expect(monitor.look).not.toHaveBeenCalled();
  });
});
