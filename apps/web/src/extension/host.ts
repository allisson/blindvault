// The session host's side of the extension's messages (extension.md §3, §4, §6.3, §7.7, D283, D286,
// D289). It answers the popup, the confirmation window and the service worker, and only them: a
// message from any other sender, a content script's included, is ignored. Nothing it answers
// carries a secret but the value the user asked to copy.

import { totpCode } from '@blindvault/crypto';
import {
  type Field,
  type ItemView,
  type VaultSession,
  fillablePage,
  matchingUrl,
} from '@blindvault/vault';

import { hex } from '../app/ids';
import { normalizeForSearch } from '../app/search';
import { type TabsPort, type Values, fillTab } from './fill';
import { type PasskeyHost } from './passkey-host';
import {
  type Answer,
  CONFIRM_PAGE,
  type Copyable,
  type Found,
  HOST_SENDERS,
  HOST_TYPES,
  type HostType,
  type Matched,
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
  /** The browser's tabs, for `matches` and filling; absent outside the extension. */
  readonly tabs?: TabsPort | undefined;
  /** The pending passkey request (§7.7); absent outside the extension. */
  readonly passkeys?: PasskeyHost | undefined;
}

const LOGIN = 'login';

/**
 * The types that are the user's interaction, each taken only from its sender (`HOST_SENDERS`), so
 * the only ones that restart the auto-lock (§3.2, D284). A passkey request comes from any page the
 * user visits, and the window's details from its loading: never activity, or a site would hold the
 * vault open (E-01).
 */
const ACTIVITY: ReadonlySet<HostType> = new Set<HostType>([
  'status',
  'search',
  'copy',
  'matches',
  'fill',
  'lock',
  'command-fill',
  'confirm-choice',
]);

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
    found.push(foundOf(view));
  }
  return byTitle(found);
}

function foundOf(view: ItemView & { item: NonNullable<ItemView['item']> }): Found {
  const { title, fields } = view.item;
  const username = text(fields.find((f) => f.role === 'username'));
  return {
    itemId: hex(view.id),
    title,
    ...(username === undefined ? {} : { username }),
    fields: (['username', 'password', 'totp'] as const).filter(
      (c) => copyable(fields, c) !== undefined,
    ),
  };
}

function byTitle<T extends Found>(found: T[]): T[] {
  const collator = new Intl.Collator();
  return found.sort((a, b) => collator.compare(a.title, b.title)).slice(0, SEARCH_MAX);
}

/** The Login items that match a page (§5, D287), with the URL that matched, in title order. */
export function matchingLogins(items: readonly ItemView[], pageUrl: string): Matched[] {
  const matched: Matched[] = [];
  for (const view of items) {
    if (!login(view)) continue;
    const url = matchingUrl(view.item, pageUrl);
    if (url !== null) matched.push({ ...foundOf(view), url });
  }
  return byTitle(matched);
}

/** The tab's page when it can match (§5.1), read from the browser, never from a message. */
async function pageOf(tabs: TabsPort | undefined, tabId: number): Promise<URL | undefined> {
  const url = tabs ? await tabs.url(tabId) : undefined;
  return (url === undefined ? null : fillablePage(url)) ?? undefined;
}

/** What a fill writes: the user name and the password the item has, never another field. */
function valuesOf(fields: readonly Field[]): Values {
  const username = text(fields.find((f) => f.role === 'username'));
  const password = text(fields.find((f) => f.role === 'password'));
  return {
    ...(username === undefined ? {} : { username }),
    ...(password === undefined ? {} : { password }),
  };
}

type FillOutcome =
  'filled' | 'locked' | 'not-found' | 'page' | 'no-match' | 'no-field' | 'no-target' | 'moved';

/** Fills a Login item into a tab, after checking again that it matches the tab's page (§6.1). */
async function fillItem(
  s: VaultSession,
  tabs: TabsPort | undefined,
  tabId: number,
  itemId: string,
): Promise<FillOutcome> {
  const view = s.items().find((v) => hex(v.id) === itemId);
  if (!view || !login(view)) return 'not-found';
  const page = await pageOf(tabs, tabId);
  if (!tabs || !page) return 'page';
  if (matchingUrl(view.item, page.href) === null) return 'no-match';
  const values = valuesOf(view.item.fields);
  if (values.username === undefined && values.password === undefined) return 'no-field';
  return fillTab(tabs, tabId, page.origin, values);
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
    case 'matches': {
      if (!s) return refusal(id, 'locked');
      const page = await pageOf(deps.tabs, request.tabId);
      if (!page) return refusal(id, 'page');
      return { v: 1, id, ok: true, items: matchingLogins(s.items(), page.href) };
    }
    case 'fill': {
      if (!s) return refusal(id, 'locked');
      const outcome = await fillItem(s, deps.tabs, request.tabId, request.itemId);
      return outcome === 'filled' ? { v: 1, id, ok: true } : refusal(id, outcome);
    }
    case 'command-fill': {
      // The shortcut fills when exactly one item matches; otherwise the popup opens (§6.2).
      const page = s ? await pageOf(deps.tabs, request.tabId) : undefined;
      const matched = s && page ? matchingLogins(s.items(), page.href) : [];
      const [only] = matched;
      const outcome =
        s && only && matched.length === 1
          ? await fillItem(s, deps.tabs, request.tabId, only.itemId)
          : 'popup';
      return { v: 1, id, ok: true, result: outcome === 'filled' ? 'filled' : 'popup' };
    }
    case 'passkey-create':
    case 'passkey-get':
      // Acknowledged at once; the result follows in `passkey-answer` (§7.7 Route, D289).
      if (!deps.passkeys) return refusal(id, 'invalid');
      deps.passkeys.start(request.passkey);
      return { v: 1, id, ok: true };
    case 'passkey-cancel':
      // The page aborted its call: its request ends, if still pending (§7.7 Route, P-03).
      deps.passkeys?.cancel(request.tabId, request.frameId, request.request);
      return { v: 1, id, ok: true };
    case 'confirm-details': {
      const state = deps.passkeys?.details(request.token) ?? 'not-found';
      return state === 'not-found' ? refusal(id, state) : { v: 1, id, ok: true, state };
    }
    case 'confirm-choice': {
      const outcome = deps.passkeys
        ? await deps.passkeys.choose(request.token, request.choice)
        : 'not-found';
      return outcome === true ? { v: 1, id, ok: true } : refusal(id, outcome);
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
    if (!fromPage(sender, runtime, [POPUP_PAGE, CONFIRM_PAGE, ...WORKER_PAGES])) return false;
    // A second extension tab holds no vault (§3.1): the session host answers alone.
    if (deps.app.status.kind === 'elsewhere') return false;
    const parsed = parseRequest(message, HOST_TYPES);
    if (parsed.kind === 'other') return false;
    // Each type from the pages that send it: `command-fill` from the service worker only (§4).
    if (
      parsed.kind === 'invalid' ||
      !fromPage(sender, runtime, HOST_SENDERS[parsed.request.type as keyof typeof HOST_SENDERS])
    ) {
      respond(refusal(parsed.kind === 'invalid' ? parsed.id : parsed.request.id, 'invalid'));
      return false;
    }
    if (ACTIVITY.has(parsed.request.type as HostType)) deps.activity();
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
