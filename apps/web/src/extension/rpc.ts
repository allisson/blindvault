// The messages between the extension's pages and its service worker (extension.md §4, D283, D286):
// JSON objects `{v: 1, type, id, ...}`, with `type` from a closed list per receiver and every key
// checked by type and range. An unknown `v`, `type` or key is refused, never acted on. It is browser
// IPC within the extension, so it carries no AAD or signature (D283).

import { HEX_32, PASSKEY_KEYS, type PasskeyRequest, parsePasskeyRequest } from './passkey-options';

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
  | { readonly v: 1; readonly type: 'matches'; readonly id: number; readonly tabId: number }
  | {
      readonly v: 1;
      readonly type: 'fill';
      readonly id: number;
      readonly tabId: number;
      readonly itemId: string;
    }
  | { readonly v: 1; readonly type: 'command-fill'; readonly id: number; readonly tabId: number }
  | { readonly v: 1; readonly type: 'open-host'; readonly id: number }
  | { readonly v: 1; readonly type: 'clipboard-clear'; readonly id: number }
  | { readonly v: 1; readonly type: 'locked'; readonly id: number }
  | {
      readonly v: 1;
      readonly type: 'passkey-create' | 'passkey-get';
      readonly id: number;
      readonly passkey: PasskeyRequest;
    }
  | {
      readonly v: 1;
      readonly type: 'passkey-cancel';
      readonly id: number;
      readonly request: string;
      readonly tabId: number;
      readonly frameId: number;
    }
  | { readonly v: 1; readonly type: 'confirm-details'; readonly id: number; readonly token: string }
  | {
      readonly v: 1;
      readonly type: 'confirm-choice';
      readonly id: number;
      readonly token: string;
      readonly choice: ConfirmChoice;
    };

/** What the user chose in the confirmation window (§7.7). */
export type ConfirmChoice =
  | { readonly choice: 'use'; readonly credentialId: string }
  | { readonly choice: 'save'; readonly itemId: string }
  | { readonly choice: 'save-new' | 'browser' | 'cancel' };

export type RequestType = Request['type'];

/**
 * What each receiver acts on; it ignores the other types, which another receiver answers. The
 * service worker's (`open-host`, `clipboard-clear`) are checked in `background.js`, which takes no
 * module of the app.
 */
export const HOST_TYPES = [
  'status',
  'search',
  'copy',
  'lock',
  'matches',
  'fill',
  'command-fill',
  'passkey-create',
  'passkey-get',
  'passkey-cancel',
  'confirm-details',
  'confirm-choice',
] as const;
export type HostType = (typeof HOST_TYPES)[number];
export const POPUP_TYPES = ['locked'] as const;

const TYPES: ReadonlySet<string> = new Set<RequestType | 'passkey-answer'>([
  'status',
  'search',
  'copy',
  'lock',
  'matches',
  'fill',
  'command-fill',
  'open-host',
  'clipboard-clear',
  'locked',
  'passkey-create',
  'passkey-get',
  'passkey-cancel',
  'passkey-answer',
  'confirm-details',
  'confirm-choice',
]);

/** The keys each type takes beside `v`, `type` and `id`. */
const KEYS: Readonly<Record<RequestType | 'passkey-answer', readonly string[]>> = {
  status: [],
  search: ['query'],
  copy: ['itemId', 'field'],
  lock: [],
  matches: ['tabId'],
  fill: ['tabId', 'itemId'],
  'command-fill': ['tabId'],
  'open-host': [],
  'clipboard-clear': [],
  locked: [],
  'passkey-create': PASSKEY_KEYS,
  'passkey-get': PASSKEY_KEYS,
  'passkey-cancel': ['request', 'tabId', 'frameId'],
  'passkey-answer': ['tabId', 'frameId', 'request', 'result'],
  'confirm-details': ['token'],
  'confirm-choice': ['token', 'choice', 'credentialId', 'itemId'],
};

const ITEM_ID = /^[0-9a-f]{32}$/;
/** A `credentialId` in hexadecimal: 1 to 1,023 bytes. */
const CREDENTIAL_HEX = /^(?:[0-9a-f]{2}){1,1023}$/;

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function requestId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** A browser's tab ID: a non-negative integer, as for a request's. */
const tabIdOf = requestId;

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
  const t = type as RequestType | 'passkey-answer';
  const allowed = new Set(['v', 'type', 'id', ...KEYS[t]]);
  if (Object.keys(value).some((k) => !allowed.has(k))) return invalid;
  if (t === 'passkey-answer' || !accepted.includes(t)) return { kind: 'other' };
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
    case 'matches':
    case 'command-fill': {
      const tabId = value.tabId;
      if (!tabIdOf(tabId)) return invalid;
      return { kind: 'request', request: { v: 1, type: t, id, tabId } };
    }
    case 'fill': {
      const { tabId, itemId } = value;
      if (!tabIdOf(tabId)) return invalid;
      if (typeof itemId !== 'string' || !ITEM_ID.test(itemId)) return invalid;
      return { kind: 'request', request: { v: 1, type: t, id, tabId, itemId } };
    }
    case 'passkey-create':
    case 'passkey-get': {
      const passkey = parsePasskeyRequest(t === 'passkey-create' ? 'create' : 'get', value);
      return passkey ? { kind: 'request', request: { v: 1, type: t, id, passkey } } : invalid;
    }
    case 'passkey-cancel': {
      const { request, tabId, frameId } = value;
      if (typeof request !== 'string' || !HEX_32.test(request)) return invalid;
      if (!tabIdOf(tabId) || !tabIdOf(frameId)) return invalid;
      return { kind: 'request', request: { v: 1, type: t, id, request, tabId, frameId } };
    }
    case 'confirm-details': {
      const token = value.token;
      if (typeof token !== 'string' || !HEX_32.test(token)) return invalid;
      return { kind: 'request', request: { v: 1, type: t, id, token } };
    }
    case 'confirm-choice': {
      const token = value.token;
      if (typeof token !== 'string' || !HEX_32.test(token)) return invalid;
      const choice = confirmChoice(value);
      return choice ? { kind: 'request', request: { v: 1, type: t, id, token, choice } } : invalid;
    }
    default:
      return { kind: 'request', request: { v: 1, type: t, id } };
  }
}

/** A `confirm-choice`'s choice: `credentialId` only with `use`, `itemId` only with `save`. */
function confirmChoice(value: Record<string, unknown>): ConfirmChoice | undefined {
  const { choice, credentialId, itemId } = value;
  if (choice === 'use') {
    if ('itemId' in value || typeof credentialId !== 'string') return undefined;
    return CREDENTIAL_HEX.test(credentialId) ? { choice, credentialId } : undefined;
  }
  if (choice === 'save') {
    if ('credentialId' in value || typeof itemId !== 'string') return undefined;
    return ITEM_ID.test(itemId) ? { choice, itemId } : undefined;
  }
  if ('credentialId' in value || 'itemId' in value) return undefined;
  return choice === 'save-new' || choice === 'browser' || choice === 'cancel'
    ? { choice }
    : undefined;
}

/** One item of a `search` answer: never a secret (D132, D286). */
export interface Found {
  readonly itemId: string;
  readonly title: string;
  readonly username?: string;
  /** What the item has to copy. */
  readonly fields: readonly Copyable[];
}

/** A Login item that matches a tab's page (§5): `Found` and the URL that matched (D287). */
export interface Matched extends Found {
  readonly url: string;
}

export type Refusal =
  | 'invalid'
  | 'locked'
  | 'not-found'
  | 'no-field'
  /** The page cannot match (§5.1), or the browser does not give its URL (D287). */
  | 'page'
  /** The item does not match the tab's page. */
  | 'no-match'
  /** The page has no sign-in field. */
  | 'no-target'
  /** The page navigated between the probe and the fill. */
  | 'moved';

export const REFUSALS: readonly Refusal[] = [
  'invalid',
  'locked',
  'not-found',
  'no-field',
  'page',
  'no-match',
  'no-target',
  'moved',
];

export type Answer =
  | { readonly v: 1; readonly id: number; readonly ok: false; readonly error: Refusal }
  | { readonly v: 1; readonly id: number; readonly ok: true; readonly state: 'locked' | 'unlocked' }
  | { readonly v: 1; readonly id: number; readonly ok: true; readonly items: readonly Found[] }
  | {
      readonly v: 1;
      readonly id: number;
      readonly ok: true;
      /** `popup`: the service worker opens the popup (§6.2). */
      readonly result: 'filled' | 'popup';
    }
  | {
      readonly v: 1;
      readonly id: number;
      readonly ok: true;
      readonly value: string;
      /** When the session host clears the clipboard, in seconds. */
      readonly clearSeconds: number;
    }
  | { readonly v: 1; readonly id: number; readonly ok: true; readonly state: ConfirmState }
  | { readonly v: 1; readonly id: number; readonly ok: true };

/** What the confirmation window shows (§7.4, §7.7): never a key or a `userHandle`. */
export type ConfirmState =
  | { readonly kind: 'locked' }
  | {
      readonly kind: 'get';
      readonly origin: string;
      readonly topOrigin?: string;
      readonly rpId: string;
      readonly passkeys: readonly {
        readonly credentialId: string;
        readonly title: string;
        readonly userName?: string;
      }[];
    }
  | {
      readonly kind: 'create';
      readonly origin: string;
      readonly topOrigin?: string;
      readonly rpId: string;
      readonly rpName: string;
      readonly userName: string;
      readonly displayName: string;
      readonly items: readonly {
        readonly itemId: string;
        readonly title: string;
        readonly username?: string;
      }[];
      readonly replaces: boolean;
    };

/** How a passkey request ends (§7.7 Result): bytes in base64url without padding. */
export type PasskeyResult =
  | { readonly kind: 'browser' }
  | { readonly kind: 'error'; readonly name: 'NotAllowedError' | 'InvalidStateError' }
  | {
      readonly kind: 'created';
      readonly id: string;
      readonly clientDataJSON: string;
      readonly attestationObject: string;
      readonly authenticatorData: string;
      readonly publicKey: string;
      readonly publicKeyAlgorithm: number;
    }
  | {
      readonly kind: 'asserted';
      readonly id: string;
      readonly clientDataJSON: string;
      readonly authenticatorData: string;
      readonly signature: string;
      readonly userHandle: string;
    };

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
export const CONFIRM_PAGE = 'confirm.html';
export const HOST_PAGE = 'index.html';
export const WORKER_PAGES = ['background.js', '_generated_background_page.html'] as const;

/** The pages each of the session host's types may come from (§4). */
export const HOST_SENDERS: Readonly<Record<HostType, readonly string[]>> = {
  status: [POPUP_PAGE],
  search: [POPUP_PAGE],
  copy: [POPUP_PAGE],
  matches: [POPUP_PAGE],
  fill: [POPUP_PAGE],
  lock: [POPUP_PAGE, CONFIRM_PAGE, ...WORKER_PAGES],
  'command-fill': WORKER_PAGES,
  'passkey-create': WORKER_PAGES,
  'passkey-get': WORKER_PAGES,
  'passkey-cancel': WORKER_PAGES,
  'confirm-details': [CONFIRM_PAGE],
  'confirm-choice': [CONFIRM_PAGE],
};

let next = 0;

/** A new request ID for this page. */
export function nextId(): number {
  return next++;
}
