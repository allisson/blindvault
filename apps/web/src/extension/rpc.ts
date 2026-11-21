// The messages between the extension's pages and its service worker (extension.md §4, D283, D286):
// JSON objects `{v: 1, type, id, ...}`, with `type` from a closed list per receiver and every key
// checked by type and range. An unknown `v`, `type` or key is refused, never acted on. It is browser
// IPC within the extension, so it carries no AAD or signature (D283).

export const RPC_VERSION = 1;

/** What the popup can copy from a Login item (§6.3). */
export const COPYABLE = ['username', 'password', 'totp'] as const;
export type Copyable = (typeof COPYABLE)[number];

/** A search query's longest length, in UTF-16 code units. */
export const QUERY_MAX = 256;
/** The most items a `search` answers (D286). */
export const SEARCH_MAX = 50;

export type Request =
  | { readonly v: 1; readonly type: 'status'; readonly id: number }
  | { readonly v: 1; readonly type: 'search'; readonly id: number; readonly query: string }
  | {
      readonly v: 1;
      readonly type: 'copy';
      readonly id: number;
      readonly itemId: string;
      readonly field: Copyable;
    }
  | { readonly v: 1; readonly type: 'lock'; readonly id: number }
  | { readonly v: 1; readonly type: 'open-host'; readonly id: number }
  | { readonly v: 1; readonly type: 'clipboard-clear'; readonly id: number }
  | { readonly v: 1; readonly type: 'locked'; readonly id: number };

export type RequestType = Request['type'];

/**
 * What each receiver acts on; it ignores the other types, which another receiver answers. The
 * service worker's (`open-host`, `clipboard-clear`) are checked in `background.js`, which takes no
 * module of the app.
 */
export const HOST_TYPES = ['status', 'search', 'copy', 'lock'] as const;
export const POPUP_TYPES = ['locked'] as const;

const TYPES: ReadonlySet<string> = new Set<RequestType>([
  'status',
  'search',
  'copy',
  'lock',
  'open-host',
  'clipboard-clear',
  'locked',
]);

/** The keys each type takes beside `v`, `type` and `id`. */
const KEYS: Readonly<Record<RequestType, readonly string[]>> = {
  status: [],
  search: ['query'],
  copy: ['itemId', 'field'],
  lock: [],
  'open-host': [],
  'clipboard-clear': [],
  locked: [],
};

const ITEM_ID = /^[0-9a-f]{32}$/;

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function requestId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export type Parsed =
  | { readonly kind: 'request'; readonly request: Request }
  /** A type another receiver answers: no answer, so that one's arrives. */
  | { readonly kind: 'other' }
  | { readonly kind: 'invalid'; readonly id?: number };

/** Reads a message for a receiver that acts on `accepted`. */
export function parseRequest(value: unknown, accepted: readonly RequestType[]): Parsed {
  if (!plainObject(value)) return { kind: 'invalid' };
  const id = requestId(value.id) ? value.id : undefined;
  const invalid: Parsed = id === undefined ? { kind: 'invalid' } : { kind: 'invalid', id };
  if (value.v !== RPC_VERSION || id === undefined) return invalid;
  const type = value.type;
  if (typeof type !== 'string' || !TYPES.has(type)) return invalid;
  const t = type as RequestType;
  const allowed = new Set(['v', 'type', 'id', ...KEYS[t]]);
  if (Object.keys(value).some((k) => !allowed.has(k))) return invalid;
  if (!accepted.includes(t)) return { kind: 'other' };
  switch (t) {
    case 'search': {
      const query = value.query;
      if (typeof query !== 'string' || query.length > QUERY_MAX) return invalid;
      return { kind: 'request', request: { v: 1, type: t, id, query } };
    }
    case 'copy': {
      const { itemId, field } = value;
      if (typeof itemId !== 'string' || !ITEM_ID.test(itemId)) return invalid;
      if (typeof field !== 'string' || !(COPYABLE as readonly string[]).includes(field)) {
        return invalid;
      }
      return { kind: 'request', request: { v: 1, type: t, id, itemId, field: field as Copyable } };
    }
    default:
      return { kind: 'request', request: { v: 1, type: t, id } };
  }
}

/** One item of a `search` answer: never a secret (D132, D286). */
export interface Found {
  readonly itemId: string;
  readonly title: string;
  readonly username?: string;
  /** What the item has to copy. */
  readonly fields: readonly Copyable[];
}

export type Refusal = 'invalid' | 'locked' | 'not-found' | 'no-field';

export type Answer =
  | { readonly v: 1; readonly id: number; readonly ok: false; readonly error: Refusal }
  | { readonly v: 1; readonly id: number; readonly ok: true; readonly state: 'locked' | 'unlocked' }
  | { readonly v: 1; readonly id: number; readonly ok: true; readonly items: readonly Found[] }
  | {
      readonly v: 1;
      readonly id: number;
      readonly ok: true;
      readonly value: string;
      /** When the session host clears the clipboard, in seconds. */
      readonly clearSeconds: number;
    }
  | { readonly v: 1; readonly id: number; readonly ok: true };

export function refusal(id: number | undefined, error: Refusal): Answer {
  return { v: 1, id: id ?? 0, ok: false, error };
}

/** The sender of a message, as the browser reports it (`runtime.MessageSender`). */
export interface Sender {
  readonly id?: string;
  readonly url?: string;
}

/**
 * Whether the browser says the message comes from one of `pages`, pages of this extension. A
 * content script's message carries the web page's URL and fails (extension.md §4).
 */
export function fromPage(
  sender: Sender,
  runtime: { readonly id: string; getURL(path: string): string },
  pages: readonly string[],
): boolean {
  if (sender.id !== runtime.id || sender.url === undefined) return false;
  // The page without its query or fragment, compared whole to the extension's own URL of it.
  const page = sender.url.split(/[?#]/)[0];
  return pages.some((p) => runtime.getURL(p) === page);
}

/** The pages each receiver hears. Firefox runs the background script in a generated page. */
export const POPUP_PAGE = 'popup.html';
export const HOST_PAGE = 'index.html';
export const WORKER_PAGES = ['background.js', '_generated_background_page.html'] as const;

let next = 0;

/** A new request ID for this page. */
export function nextId(): number {
  return next++;
}
