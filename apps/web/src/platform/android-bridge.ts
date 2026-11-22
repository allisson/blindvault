// The window's side of the bridge to the Android shell (android.md §9, D290): JSON text over the
// object `addWebMessageListener` sets, `blindvaultShell`, which the shell exposes to the app's origin
// in the main frame only. Requests are `{v: 1, type, id, ...}`; an answer is taken only for a
// request pending, and any other message is ignored, never acted on.

export const BRIDGE_VERSION = 1;

export const SHELL_ERRORS = [
  'invalid',
  'cancelled',
  'invalidated',
  'unavailable',
  'failed',
] as const;
export type ShellError = (typeof SHELL_ERRORS)[number];

/** The shell answered `ok: false`. */
export class ShellRefusedError extends Error {
  override name = 'ShellRefusedError';
  constructor(readonly error: ShellError) {
    super(`The shell answered ${error}`);
  }
}

export const LIFECYCLE_STATES = ['hidden', 'shown', 'screen-off'] as const;
export type Lifecycle = (typeof LIFECYCLE_STATES)[number];

/** The object `WebViewCompat.addWebMessageListener` puts on the page. */
export interface ShellObject {
  postMessage(message: string): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
}

export type ShellAnswer = Readonly<Record<string, unknown>>;

export interface ShellBridge {
  /** Sends `type` with `fields`; resolves with the `ok` answer, rejects with the refusal. */
  request(type: string, fields?: Readonly<Record<string, unknown>>): Promise<ShellAnswer>;
  /** Calls `listener` on each `lifecycle` the shell sends (§4.2); returns the unsubscribe. */
  onLifecycle(listener: (state: Lifecycle) => void): () => void;
}

/** The shell's object; `undefined` outside the app's WebView (the tests, a browser). */
export function androidShell(): ShellObject | undefined {
  const shell = (globalThis as { blindvaultShell?: Partial<ShellObject> }).blindvaultShell;
  return typeof shell?.postMessage === 'function' && typeof shell.addEventListener === 'function'
    ? (shell as ShellObject)
    : undefined;
}

function parse(data: unknown): Record<string, unknown> | undefined {
  if (typeof data !== 'string') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return undefined;
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function keysAre(message: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(message);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(message, k));
}

function isLifecycle(state: unknown): state is Lifecycle {
  return LIFECYCLE_STATES.includes(state as Lifecycle);
}

function isError(error: unknown): error is ShellError {
  return SHELL_ERRORS.includes(error as ShellError);
}

export function shellBridge(shell: ShellObject): ShellBridge {
  let lastId = 0;
  const waiting = new Map<
    number,
    { resolve: (answer: ShellAnswer) => void; reject: (error: Error) => void }
  >();
  const lifecycle = new Set<(state: Lifecycle) => void>();

  shell.addEventListener('message', ({ data }) => {
    const message = parse(data);
    if (message?.v !== BRIDGE_VERSION) return;
    if (message.type === 'lifecycle') {
      if (!keysAre(message, ['v', 'type', 'state']) || !isLifecycle(message.state)) return;
      for (const l of lifecycle) l(message.state);
      return;
    }
    const { id, ok } = message;
    if (typeof id !== 'number' || typeof ok !== 'boolean') return;
    const request = waiting.get(id);
    if (!request) return;
    if (ok) {
      if (Object.hasOwn(message, 'error')) return;
      waiting.delete(id);
      request.resolve(message);
      return;
    }
    if (!keysAre(message, ['v', 'id', 'ok', 'error']) || !isError(message.error)) return;
    waiting.delete(id);
    request.reject(new ShellRefusedError(message.error));
  });

  return {
    request: (type, fields = {}) =>
      new Promise((resolve, reject) => {
        lastId += 1;
        const id = lastId;
        waiting.set(id, { resolve, reject });
        shell.postMessage(JSON.stringify({ ...fields, v: BRIDGE_VERSION, type, id }));
      }),
    onLifecycle: (listener) => {
      lifecycle.add(listener);
      return () => {
        lifecycle.delete(listener);
      };
    },
  };
}
