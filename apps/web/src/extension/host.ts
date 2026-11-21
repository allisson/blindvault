// The session host's side of the extension's messages (extension.md §3, §4, §6.3, D283, D286). It
// answers the popup and the service worker, and only them: a message from any other sender, a
// content script's included, is ignored. Nothing it answers carries a secret but the value the user
// asked to copy.

import { totpCode } from '@blindvault/crypto';
import { type Field, type ItemView, type VaultSession } from '@blindvault/vault';

import { hex } from '../app/ids';
import { normalizeForSearch } from '../app/search';
import {
  type Answer,
  type Copyable,
  type Found,
  HOST_TYPES,
  POPUP_PAGE,
  type Request,
  SEARCH_MAX,
  type Sender,
  WORKER_PAGES,
  fromPage,
  nextId,
  parseRequest,
  refusal,
} from './rpc';

/** The part of the app the session host answers from. */
export interface HostApp {
  readonly status: { readonly kind: string; readonly session?: VaultSession };
  lock(): void;
  subscribe(listener: () => void): () => void;
}

export interface HostDeps {
  readonly app: HostApp;
  /** An interaction with the popup, which restarts the auto-lock (D284). */
  readonly activity: () => void;
  /** The popup copied: the session host clears the clipboard after `seconds` (§6.3). */
  readonly copied: (seconds: number) => void;
  readonly now: () => number;
}

const LOGIN = 'login';

function session(app: HostApp): VaultSession | undefined {
  return app.status.kind === 'unlocked' ? app.status.session : undefined;
}

/** A Login item outside the trash, readable by this app. */
function login(view: ItemView): view is ItemView & { item: NonNullable<ItemView['item']> } {
  return !view.inTrash && view.item?.templateId === LOGIN;
}

function text(field: Field | undefined): string | undefined {
  return typeof field?.value === 'string' && field.value !== '' ? field.value : undefined;
}

function copyable(fields: readonly Field[], what: Copyable): Field | undefined {
  if (what === 'totp') return fields.find((f) => f.type === 'totp');
  const field = fields.find((f) => f.role === what);
  return text(field) === undefined ? undefined : field;
}

/**
 * The Login items whose title, user name or URL holds every term of `query`, in title order. An
 * empty query lists them all. No secret field is read (D132).
 */
export function searchLogins(items: readonly ItemView[], query: string): Found[] {
  const terms = normalizeForSearch(query)
    .split(/\s+/u)
    .filter((t) => t !== '');
  const found: Found[] = [];
  for (const view of items) {
    if (!login(view)) continue;
    const { title, fields } = view.item;
    const username = text(fields.find((f) => f.role === 'username'));
    const urls = fields.filter((f) => f.type === 'url').map(text);
    const haystack = normalizeForSearch([title, username, ...urls].filter(Boolean).join('\n'));
    if (!terms.every((t) => haystack.includes(t))) continue;
    found.push({
      itemId: hex(view.id),
      title,
      ...(username === undefined ? {} : { username }),
      fields: (['username', 'password', 'totp'] as const).filter(
        (c) => copyable(fields, c) !== undefined,
      ),
    });
  }
  const collator = new Intl.Collator();
  return found.sort((a, b) => collator.compare(a.title, b.title)).slice(0, SEARCH_MAX);
}

/** The answer to one request of the popup or the service worker. */
export async function answer(request: Request, deps: HostDeps): Promise<Answer> {
  const { id } = request;
  const s = session(deps.app);
  switch (request.type) {
    case 'status':
      return { v: 1, id, ok: true, state: s ? 'unlocked' : 'locked' };
    case 'lock':
      deps.app.lock();
      return { v: 1, id, ok: true };
    case 'search':
      if (!s) return refusal(id, 'locked');
      return { v: 1, id, ok: true, items: searchLogins(s.items(), request.query) };
    case 'copy': {
      if (!s) return refusal(id, 'locked');
      const view = s.items().find((v) => hex(v.id) === request.itemId);
      if (!view || !login(view)) return refusal(id, 'not-found');
      const field = copyable(view.item.fields, request.field);
      if (!field) return refusal(id, 'no-field');
      const value =
        typeof field.value === 'string'
          ? field.value
          : 'secret' in field.value
            ? await totpCode(field.value, deps.now())
            : undefined;
      if (value === undefined) return refusal(id, 'no-field');
      const clearSeconds = s.preferences.clipboardClearSeconds;
      deps.copied(clearSeconds);
      return { v: 1, id, ok: true, value, clearSeconds };
    }
    default:
      return refusal(id, 'invalid');
  }
}

/** The part of `chrome.runtime` the session host's messages use. */
export interface HostRuntime {
  readonly id: string;
  getURL(path: string): string;
  readonly onMessage: {
    addListener(
      listener: (message: unknown, sender: Sender, respond: (answer: Answer) => void) => boolean,
    ): void;
  };
  sendMessage(message: unknown): Promise<unknown>;
}

/** The extension's runtime; `undefined` outside an extension page (the tests, the dev server). */
export function hostRuntime(): HostRuntime | undefined {
  const runtime = (globalThis as { chrome?: { runtime?: Partial<HostRuntime> } }).chrome?.runtime;
  return runtime?.id && runtime.onMessage ? (runtime as HostRuntime) : undefined;
}

/** Answers the popup and the service worker, and tells the popup when the vault locks. */
export function serveHost(runtime: HostRuntime, deps: HostDeps): void {
  runtime.onMessage.addListener((message, sender, respond) => {
    if (!fromPage(sender, runtime, [POPUP_PAGE, ...WORKER_PAGES])) return false;
    // A second extension tab holds no vault (§3.1): the session host answers alone.
    if (deps.app.status.kind === 'elsewhere') return false;
    const parsed = parseRequest(message, HOST_TYPES);
    if (parsed.kind === 'other') return false;
    if (parsed.kind === 'invalid') {
      respond(refusal(parsed.id, 'invalid'));
      return false;
    }
    deps.activity();
    answer(parsed.request, deps).then(respond, () => {
      respond(refusal(parsed.request.id, 'invalid'));
    });
    return true;
  });
  let unlocked = session(deps.app) !== undefined;
  deps.app.subscribe(() => {
    const now = session(deps.app) !== undefined;
    if (unlocked && !now) {
      // No popup open: no receiver, and nothing to close.
      runtime.sendMessage({ v: 1, type: 'locked', id: nextId() }).catch(() => undefined);
    }
    unlocked = now;
  });
}
