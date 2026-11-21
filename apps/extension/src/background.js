// @ts-check
// The extension's service worker in Chrome, its event page in Firefox (extension.md §1). It holds no
// state and no key. Shipped as written, with no bundler. It opens the session host, the app in a
// pinned tab, or focuses it (D286); clears the clipboard for the session host (§6.3); takes the
// `fill` command and hands it to the session host (§6.2, D287); relays passkey requests and their
// answers between the content scripts and the session host (§7.7, D289); and defers an update while
// a session host exists (§8.1): the session host reloads the extension once the vault is locked.

/**
 * @typedef {object} Context
 * @property {string} [documentUrl]
 * @property {number} tabId
 * @property {number} windowId
 *
 * @typedef {object} Listened
 * @property {(listener: (...args: any[]) => unknown) => void} addListener
 *
 * @typedef {object} Sender
 * @property {string} [id]
 * @property {string} [url]
 * @property {string | undefined} [origin]
 * @property {number | undefined} [frameId]
 * @property {{ id?: number, url?: string } | undefined} [tab]
 *
 * @typedef {object} Api The part of `chrome.*` this script uses.
 * @property {object} runtime
 * @property {string} [runtime.id]
 * @property {(path: string) => string} runtime.getURL
 * @property {(filter: { contextTypes: string[] }) => Promise<Context[]>} runtime.getContexts
 * @property {() => void} runtime.reload
 * @property {(message: unknown) => Promise<unknown>} runtime.sendMessage
 * @property {Listened} runtime.onUpdateAvailable
 * @property {Listened} runtime.onMessage
 * @property {{ openPopup: () => Promise<void> }} action
 * @property {{ onCommand: Listened }} commands
 * @property {object} tabs
 * @property {(properties: { url: string, pinned: boolean, active?: boolean }) => Promise<unknown>} tabs.create
 * @property {(tabId: number, message: unknown, options: { frameId: number }) => Promise<unknown>} tabs.sendMessage
 * @property {(tabId: number, properties: { active: boolean }) => Promise<unknown>} tabs.update
 * @property {{ update: (windowId: number, properties: { focused: boolean }) => Promise<unknown> }} windows
 * @property {Offscreen} [offscreen] Chrome only.
 *
 * @typedef {{ writeText: (text: string) => Promise<void> }} Clipboard Firefox's event page's.
 *
 * @typedef {object} Offscreen
 * @property {(parameters: { url: string, reasons: string[], justification: string }) => Promise<void>} createDocument
 * @property {() => Promise<void>} closeDocument
 * @property {() => Promise<boolean>} hasDocument
 */

export const HOST_PAGE = 'index.html';
export const POPUP_PAGE = 'popup.html';
export const OFFSCREEN_PAGE = 'offscreen.html';

/**
 * The tab showing the session host, if one is open.
 * @param {Api} api
 * @returns {Promise<Context | undefined>}
 */
export async function findHost(api) {
  const url = api.runtime.getURL(HOST_PAGE);
  const tabs = await api.runtime.getContexts({ contextTypes: ['TAB'] });
  return tabs.find((c) => c.documentUrl === url);
}

/** @param {Api} api */
export async function openHost(api) {
  const host = await findHost(api);
  if (host) {
    await api.tabs.update(host.tabId, { active: true });
    await api.windows.update(host.windowId, { focused: true });
    return;
  }
  await api.tabs.create({ url: api.runtime.getURL(HOST_PAGE), pinned: true });
}

/**
 * With no session host, no vault is open here: the update applies at once.
 * @param {Api} api
 */
export async function updateAvailable(api) {
  if (!(await findHost(api))) api.runtime.reload();
}

/**
 * Writes the empty string without the focus: Chrome through an offscreen document, Firefox from
 * this event page (§6.3, D282).
 * @param {Api} api
 * @param {Clipboard | undefined} clipboard
 */
export async function clearClipboard(api, clipboard) {
  const offscreen = api.offscreen;
  if (!offscreen) {
    if (!clipboard) throw new Error('no clipboard');
    await clipboard.writeText('');
    return;
  }
  if (await offscreen.hasDocument()) await offscreen.closeDocument();
  await offscreen.createDocument({
    url: OFFSCREEN_PAGE,
    reasons: ['CLIPBOARD'],
    justification: 'Clears the clipboard after a copy.',
  });
  await offscreen.closeDocument();
}

/**
 * Whether the session host filled the tab: its answer to `command-fill` (§4).
 * @param {unknown} answer
 */
function filled(answer) {
  if (typeof answer !== 'object' || answer === null) return false;
  const a = /** @type {Record<string, unknown>} */ (answer);
  return a.v === 1 && a.id === 0 && a.ok === true && a.result === 'filled';
}

/**
 * The `fill` command (§6.2). On the session host's own tab the browser took the app's lock shortcut,
 * so it locks (D286). On another tab the session host fills when exactly one item matches; any other
 * answer, or none, opens the popup.
 * @param {Api} api
 * @param {{ id?: number } | undefined} tab
 */
export async function command(api, tab) {
  const host = await findHost(api);
  if (host && tab?.id === host.tabId) {
    await api.runtime.sendMessage({ v: 1, type: 'lock', id: 0 }).catch(() => undefined);
    return;
  }
  if (host && tab?.id !== undefined) {
    const answer = await api.runtime
      .sendMessage({ v: 1, type: 'command-fill', id: 0, tabId: tab.id })
      .catch(() => undefined);
    if (filled(answer)) return;
  }
  await api.action.openPopup().catch(() => undefined);
}

export const CONFIRM_PAGE = 'confirm.html';

/** The types the service worker answers, and the pages each may come from (extension.md §4). */
const PAGES = /** @type {const} */ ({
  'open-host': [POPUP_PAGE, CONFIRM_PAGE],
  'clipboard-clear': [HOST_PAGE],
  'passkey-answer': [HOST_PAGE],
});
/** The keys of each type beside `v`, `type` and `id` (§4, §7.7). */
const KEYS = /** @type {const} */ ({
  'open-host': [],
  'clipboard-clear': [],
  'passkey-answer': ['tabId', 'frameId', 'request', 'result'],
  'passkey-create': ['request', 'options'],
  'passkey-get': ['request', 'options'],
});
/** Every type of the extension's messages: the others are answered by another page. */
const TYPES = [
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
  'passkey-answer',
  'confirm-details',
  'confirm-choice',
];
const REQUEST = /^[0-9a-f]{32}$/;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is number} */
function index(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * A page's origin as the browser reports it: `sender.origin`, or the origin of `sender.url` where
 * the browser gives none. Never a value of the message (§7.2).
 * @param {Sender} sender
 */
function senderOrigin(sender) {
  if (typeof sender.origin === 'string') return sender.origin;
  try {
    return sender.url === undefined ? undefined : new URL(sender.url).origin;
  } catch {
    return undefined;
  }
}

/** @param {string | undefined} url */
function originOf(url) {
  try {
    return url === undefined ? undefined : new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * @typedef {{ type: 'open-host' | 'clipboard-clear' }
 *   | { type: 'passkey-answer', tabId: number, frameId: number, request: string, result: Record<string, unknown> }
 *   | { type: 'passkey-create' | 'passkey-get', request: string, options: Record<string, unknown>,
 *       tabId: number, frameId: number, origin: string, topOrigin: string }} Handled
 */

/**
 * The request when it is one the service worker answers, from the sender it expects; `undefined`
 * when another page answers it; `null` when it is refused. A passkey request comes from a content
 * script, so from a tab; its origin, frame and top frame's origin are the browser's (§7.2).
 * @param {unknown} message
 * @param {Sender} sender
 * @param {Api} api
 * @returns {Handled | undefined | null}
 */
export function parseRequest(message, sender, api) {
  if (!object(message)) return null;
  const m = message;
  const type = m.type;
  if (typeof type !== 'string' || !TYPES.includes(type)) return null;
  if (!(type in KEYS)) return undefined;
  const t = /** @type {keyof typeof KEYS} */ (type);
  const allowed = ['v', 'type', 'id', ...KEYS[t]];
  const keys = Object.keys(m);
  if (keys.length !== allowed.length || !keys.every((k) => allowed.includes(k))) return null;
  if (m.v !== 1 || !index(m.id) || sender.id !== api.runtime.id) return null;
  if (t === 'passkey-create' || t === 'passkey-get') {
    const { request, options } = m;
    if (typeof request !== 'string' || !REQUEST.test(request) || !object(options)) return null;
    const tabId = sender.tab?.id;
    const { frameId } = sender;
    const origin = senderOrigin(sender);
    const topOrigin = originOf(sender.tab?.url);
    // A message whose sender has no tab is not a page's: dropped.
    if (!index(tabId) || !index(frameId) || origin === undefined || topOrigin === undefined) {
      return null;
    }
    return { type: t, request, options, tabId, frameId, origin, topOrigin };
  }
  // The page without its query or fragment; `URL.origin` is "null" for an extension's scheme
  // outside a browser.
  const page = sender.url?.split(/[?#]/)[0];
  if (!PAGES[t].some((p) => api.runtime.getURL(p) === page)) return null;
  if (t !== 'passkey-answer') return { type: t };
  const { tabId, frameId, request, result } = m;
  if (!index(tabId) || !index(frameId) || typeof request !== 'string' || !REQUEST.test(request)) {
    return null;
  }
  return object(result) ? { type: t, tabId, frameId, request, result } : null;
}

/** How long the service worker waits for a new session host to listen (§7.4). */
export const FORWARD_TRIES = 80;
export const FORWARD_PAUSE = 250;

/** @param {number} ms */
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @type {Promise<unknown> | undefined} A session host being created, so two requests make one. */
let creating;

/**
 * Hands a passkey request to the session host (§7.7 Route, step 2), creating one pinned in the
 * background when none exists (§7.4). Whether the session host accepted it.
 * @param {Api} api
 * @param {Extract<Handled, { type: 'passkey-create' | 'passkey-get' }>} request
 * @param {(ms: number) => Promise<unknown>} [wait]
 */
export async function forwardPasskey(api, request, wait = pause) {
  // Checked again after the lookup: another request may have started one meanwhile.
  if (!creating && !(await findHost(api)) && !creating) {
    creating = api.tabs.create({ url: api.runtime.getURL(HOST_PAGE), pinned: true, active: false });
  }
  await creating?.finally(() => {
    creating = undefined;
  });
  const message = { v: 1, id: 0, ...request };
  for (let i = 0; i < FORWARD_TRIES; i++) {
    const answer = await api.runtime.sendMessage(message).catch(() => undefined);
    // No answer: the session host is still loading, or no page listens yet.
    if (answer !== undefined && answer !== null) {
      return object(answer) && answer.v === 1 && answer.id === 0 && answer.ok === true;
    }
    await wait(FORWARD_PAUSE);
  }
  return false;
}

/**
 * Hands the session host's answer to the frame that asked (§7.7 Route, step 4).
 * @param {Api} api
 * @param {Extract<Handled, { type: 'passkey-answer' }>} answer
 */
export async function deliverAnswer(api, answer) {
  const { tabId, frameId, request, result } = answer;
  await api.tabs.sendMessage(
    tabId,
    { v: 1, type: 'passkey-answer', id: 0, request, result },
    { frameId },
  );
}

/**
 * Registers the listeners, at the top level as Manifest V3 asks.
 * @param {Api} api
 * @param {Clipboard} [clipboard] Firefox's event page writes the clipboard itself.
 */
export function start(api, clipboard) {
  api.runtime.onUpdateAvailable.addListener(() => {
    void updateAvailable(api);
  });
  api.commands.onCommand.addListener(
    /** @param {string} name @param {{ id?: number } | undefined} tab */
    (name, tab) => {
      if (name === 'fill') void command(api, tab);
    },
  );
  api.runtime.onMessage.addListener(
    /**
     * @param {unknown} message
     * @param {Sender} sender
     * @param {(answer: unknown) => void} respond
     */
    (message, sender, respond) => {
      const request = parseRequest(message, sender, api);
      if (request === undefined) return false;
      const id = /** @type {{ id?: unknown }} */ (message).id;
      const answerId = index(id) ? id : 0;
      const ok = () => {
        respond({ v: 1, id: answerId, ok: true });
      };
      const refuse = () => {
        respond({ v: 1, id: answerId, ok: false, error: 'invalid' });
      };
      if (request === null) {
        // A message no page of the extension sends, or from a sender that may not send it.
        refuse();
        return false;
      }
      if (request.type === 'passkey-answer') {
        // The frame may be gone: its page's call ended with it.
        deliverAnswer(api, request).catch(() => undefined);
        return false;
      }
      if (request.type === 'passkey-create' || request.type === 'passkey-get') {
        forwardPasskey(api, request).then((accepted) => {
          (accepted ? ok : refuse)();
        }, refuse);
        return true;
      }
      const work = request.type === 'open-host' ? openHost(api) : clearClipboard(api, clipboard);
      work.then(ok, refuse);
      return true;
    },
  );
}

const api = /** @type {{ chrome?: Api }} */ (globalThis).chrome;
// Chrome's service worker has no `navigator.clipboard`, and uses the offscreen document.
if (api?.runtime.id) start(api, globalThis.navigator?.clipboard);
