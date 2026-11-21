// @ts-check
// The extension's service worker in Chrome, its event page in Firefox (extension.md §1). It holds no
// state and no key. Shipped as written, with no bundler. The toolbar button opens the session host,
// the app in a pinned tab, or focuses it; until the popup exists (extension.md §6.1) the button
// has none. An update waits while a session host exists (§8.1): the session host reloads the
// extension once the vault is locked.

/**
 * @typedef {object} Context
 * @property {string} [documentUrl]
 * @property {number} tabId
 * @property {number} windowId
 *
 * @typedef {object} Listened
 * @property {(listener: () => void) => void} addListener
 *
 * @typedef {object} Api The part of `chrome.*` this script uses.
 * @property {object} runtime
 * @property {string} [runtime.id]
 * @property {(path: string) => string} runtime.getURL
 * @property {(filter: { contextTypes: string[] }) => Promise<Context[]>} runtime.getContexts
 * @property {() => void} runtime.reload
 * @property {Listened} runtime.onUpdateAvailable
 * @property {{ onClicked: Listened }} action
 * @property {object} tabs
 * @property {(properties: { url: string, pinned: boolean }) => Promise<unknown>} tabs.create
 * @property {(tabId: number, properties: { active: boolean }) => Promise<unknown>} tabs.update
 * @property {{ update: (windowId: number, properties: { focused: boolean }) => Promise<unknown> }} windows
 */

export const HOST_PAGE = 'index.html';

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
 * Registers the listeners, at the top level as Manifest V3 asks.
 * @param {Api} api
 */
export function start(api) {
  api.action.onClicked.addListener(() => {
    void openHost(api);
  });
  api.runtime.onUpdateAvailable.addListener(() => {
    void updateAvailable(api);
  });
}

const api = /** @type {{ chrome?: Api }} */ (globalThis).chrome;
if (api?.runtime.id) start(api);
