// The popup's side of the extension's messages (extension.md §4, §6, D283, D286). The popup holds no
// key and never unlocks: it asks the session host, and the service worker for `open-host`. Answers
// are checked as strictly as requests, and an answer that does not fit is treated as none.

import {
  COPYABLE,
  type Copyable,
  type Found,
  HOST_PAGE,
  type Matched,
  POPUP_TYPES,
  REFUSALS,
  type Refusal,
  type Sender,
  fromPage,
  nextId,
  parseRequest,
} from './rpc';

/** The part of `chrome.runtime` the popup uses. */
export interface PopupRuntime {
  readonly id: string;
  getURL(path: string): string;
  sendMessage(message: unknown): Promise<unknown>;
  readonly onMessage: {
    addListener(listener: (message: unknown, sender: Sender) => boolean): void;
  };
}

/** The extension's runtime; `undefined` outside an extension page. */
export function popupRuntime(): PopupRuntime | undefined {
  const runtime = (globalThis as { chrome?: { runtime?: Partial<PopupRuntime> } }).chrome?.runtime;
  return runtime?.id && runtime.sendMessage ? (runtime as PopupRuntime) : undefined;
}

export type Fields = Record<string, unknown>;

/** Sends one request; the answer when it is ours and well formed, else `undefined`. */
export async function ask(
  runtime: PopupRuntime,
  request: Fields & { readonly type: string },
): Promise<Fields | undefined> {
  const id = nextId();
  let answer: unknown;
  try {
    answer = await runtime.sendMessage({ v: 1, id, ...request });
  } catch {
    // No session host: no receiver.
    return undefined;
  }
  if (typeof answer !== 'object' || answer === null) return undefined;
  const a = answer as Fields;
  return a.v === 1 && a.id === id && typeof a.ok === 'boolean' ? a : undefined;
}

export function refused(a: Fields): Refusal | undefined {
  return a.ok === false &&
    typeof a.error === 'string' &&
    (REFUSALS as readonly string[]).includes(a.error)
    ? (a.error as Refusal)
    : undefined;
}

export type HostState = 'unlocked' | 'locked';

/** No answer means no session host, so the vault is locked here (D286). */
export async function status(runtime: PopupRuntime): Promise<HostState> {
  const a = await ask(runtime, { type: 'status' });
  return a?.ok === true && a.state === 'unlocked' ? 'unlocked' : 'locked';
}

function found(value: unknown): value is Found {
  if (typeof value !== 'object' || value === null) return false;
  const f = value as Fields;
  return (
    typeof f.itemId === 'string' &&
    typeof f.title === 'string' &&
    (f.username === undefined || typeof f.username === 'string') &&
    Array.isArray(f.fields) &&
    f.fields.every((c) => (COPYABLE as readonly unknown[]).includes(c))
  );
}

export async function search(
  runtime: PopupRuntime,
  query: string,
): Promise<readonly Found[] | Refusal | undefined> {
  const a = await ask(runtime, { type: 'search', query });
  if (!a) return undefined;
  if (a.ok === true && Array.isArray(a.items) && a.items.every(found)) return a.items;
  return refused(a);
}

function matched(value: unknown): value is Matched {
  return found(value) && typeof (value as unknown as Fields).url === 'string';
}

/** The Login items that match the tab's page (§6.1), or why none can. */
export async function matches(
  runtime: PopupRuntime,
  tabId: number,
): Promise<readonly Matched[] | Refusal | undefined> {
  const a = await ask(runtime, { type: 'matches', tabId });
  if (!a) return undefined;
  if (a.ok === true && Array.isArray(a.items) && a.items.every(matched)) return a.items;
  return refused(a);
}

/** Fills a matching item into the tab: `true` once done, or why it was refused. */
export async function fill(
  runtime: PopupRuntime,
  tabId: number,
  itemId: string,
): Promise<true | Refusal | undefined> {
  const a = await ask(runtime, { type: 'fill', tabId, itemId });
  if (!a) return undefined;
  if (a.ok === true) return true;
  return refused(a);
}

/**
 * The tab the popup was opened over: the active tab of its window. The browser grants `activeTab`
 * on it for the user's click (§6.1).
 */
export async function activeTab(): Promise<number | undefined> {
  const tabs = (
    globalThis as {
      chrome?: { tabs?: { query(q: object): Promise<{ id?: number }[]> } };
    }
  ).chrome?.tabs;
  try {
    const [tab] = (await tabs?.query({ active: true, currentWindow: true })) ?? [];
    return tab?.id;
  } catch {
    return undefined;
  }
}

export interface Copied {
  readonly value: string;
  readonly clearSeconds: number;
}

export async function copy(
  runtime: PopupRuntime,
  itemId: string,
  field: Copyable,
): Promise<Copied | Refusal | undefined> {
  const a = await ask(runtime, { type: 'copy', itemId, field });
  if (!a) return undefined;
  if (a.ok === true && typeof a.value === 'string' && typeof a.clearSeconds === 'number') {
    return { value: a.value, clearSeconds: a.clearSeconds };
  }
  return refused(a);
}

export async function lock(runtime: PopupRuntime): Promise<void> {
  await ask(runtime, { type: 'lock' });
}

/** Answered by the service worker, which opens the session host or focuses it (D286). */
export async function openHost(runtime: PopupRuntime): Promise<void> {
  await ask(runtime, { type: 'open-host' });
}

/** Calls `listener` when the session host says the vault locked (§3.2). */
export function onLocked(runtime: PopupRuntime, listener: () => void): void {
  runtime.onMessage.addListener((message, sender) => {
    if (!fromPage(sender, runtime, [HOST_PAGE])) return false;
    const parsed = parseRequest(message, POPUP_TYPES);
    if (parsed.kind === 'request') listener();
    return false;
  });
}
