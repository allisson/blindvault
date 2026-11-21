// @ts-check
// The extension's service worker in Chrome, its event page in Firefox (extension.md §1). It holds no
// state and no key. Shipped as written, with no bundler. It opens the session host, the app in a
// pinned tab, or focuses it (D286); clears the clipboard for the session host (§6.3); takes the
// `fill` command and hands it to the session host (§6.2, D287); and defers an update while a session
// host exists (§8.1): the session host reloads the extension once the vault is locked.

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
 * @property {(properties: { url: string, pinned: boolean }) => Promise<unknown>} tabs.create
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

/** What the service worker answers, and the one page each may come from (extension.md §4). */
const HANDLED = /** @type {const} */ ({ 'open-host': POPUP_PAGE, 'clipboard-clear': HOST_PAGE });
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
];

/**
 * The request when it is one the service worker answers, from the page it expects; `undefined`
 * when another page answers it; `null` when it is refused.
 * @param {unknown} message
 * @param {Sender} sender
 * @param {Api} api
 * @returns {'open-host' | 'clipboard-clear' | undefined | null}
 */
export function parseRequest(message, sender, api) {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return null;
  const m = /** @type {Record<string, unknown>} */ (message);
  const keys = Object.keys(m);
  if (keys.length !== 3 || !keys.every((k) => k === 'v' || k === 'type' || k === 'id')) {
    return typeof m.type === 'string' && !(m.type in HANDLED) ? undefined : null;
  }
  if (m.v !== 1 || typeof m.id !== 'number' || !Number.isSafeInteger(m.id) || m.id < 0) return null;
  if (typeof m.type !== 'string' || !TYPES.includes(m.type)) return null;
  if (!(m.type in HANDLED)) return undefined;
  const type = /** @type {'open-host' | 'clipboard-clear'} */ (m.type);
  if (sender.id !== api.runtime.id || sender.url === undefined) return null;
  // The page without its query or fragment; `URL.origin` is "null" for an extension's scheme
  // outside a browser.
  return sender.url.split(/[?#]/)[0] === api.runtime.getURL(HANDLED[type]) ? type : null;
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
      const type = parseRequest(message, sender, api);
      if (type === undefined) return false;
      const id = /** @type {{ id?: unknown }} */ (message).id;
      const answerId = typeof id === 'number' && Number.isSafeInteger(id) && id >= 0 ? id : 0;
      if (type === null) {
        // A message no page of the extension sends, or from a sender that may not send it.
        respond({ v: 1, id: answerId, ok: false, error: 'invalid' });
        return false;
      }
      const work = type === 'open-host' ? openHost(api) : clearClipboard(api, clipboard);
      work.then(
        () => {
          respond({ v: 1, id: answerId, ok: true });
        },
        () => {
          respond({ v: 1, id: answerId, ok: false, error: 'invalid' });
        },
      );
      return true;
    },
  );
}

const api = /** @type {{ chrome?: Api }} */ (globalThis).chrome;
// Chrome's service worker has no `navigator.clipboard`, and uses the offscreen document.
if (api?.runtime.id) start(api, globalThis.navigator?.clipboard);
