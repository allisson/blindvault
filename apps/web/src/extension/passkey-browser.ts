// The browser's side of stored passkeys in the session host (extension.md §7.1, §7.4, D289): the
// confirmation window, and the content scripts behind Settings › Passkeys. The `chrome.*` APIs are
// declared here to the extent used, with no type package (§2).

import { CONFIRM_PAGE } from './rpc';
import { type ConfirmWindows } from './passkey-host';

const ALL_URLS = ['<all_urls>'];

/** The content scripts of `apps/extension`, at `document_start` in every frame (§7.1, §7.2). */
export const PASSKEY_SCRIPTS = [
  {
    id: 'passkey-main',
    js: ['passkey-main.js'],
    matches: ALL_URLS,
    runAt: 'document_start',
    allFrames: true,
    world: 'MAIN',
  },
  {
    id: 'passkey-isolated',
    js: ['passkey-isolated.js'],
    matches: ALL_URLS,
    runAt: 'document_start',
    allFrames: true,
  },
] as const;

const IDS = PASSKEY_SCRIPTS.map((s) => s.id);

interface ScriptsApi {
  permissions: {
    contains(p: { origins: string[] }): Promise<boolean>;
    request(p: { origins: string[] }): Promise<boolean>;
    remove(p: { origins: string[] }): Promise<boolean>;
  };
  scripting: {
    registerContentScripts(scripts: readonly object[]): Promise<void>;
    unregisterContentScripts(filter: { ids: string[] }): Promise<void>;
    getRegisteredContentScripts(filter: { ids: string[] }): Promise<readonly { id: string }[]>;
  };
}

/** The switch of Settings › Passkeys: the browser's state, nothing stored (§7.1). */
export interface PasskeySwitch {
  /** Whether the host permission is held. */
  on(): Promise<boolean>;
  /** Asks the permission, on the user's click, and registers the scripts once granted. */
  enable(): Promise<boolean>;
  /** Unregisters the scripts and gives the permission back. */
  disable(): Promise<void>;
  /** Registers the scripts again when the permission is held, as at start (D289). */
  restore(): Promise<void>;
}

/** The switch over the given browser APIs. */
export function passkeySwitch(api: ScriptsApi): PasskeySwitch {
  const unregister = async () => {
    const held = await api.scripting.getRegisteredContentScripts({ ids: IDS });
    if (held.length > 0) {
      await api.scripting.unregisterContentScripts({ ids: held.map((s) => s.id) });
    }
  };
  const register = async () => {
    // A registration lost in an update, or left by an older one, is replaced whole.
    await unregister();
    await api.scripting.registerContentScripts(PASSKEY_SCRIPTS);
  };
  return {
    on: () => api.permissions.contains({ origins: ALL_URLS }),
    enable: async () => {
      // The first call of the click: the browser asks the permission only in a user gesture.
      const granted = await api.permissions.request({ origins: ALL_URLS });
      if (granted) await register();
      return granted;
    },
    disable: async () => {
      await unregister();
      await api.permissions.remove({ origins: ALL_URLS });
    },
    restore: async () => {
      if (await api.permissions.contains({ origins: ALL_URLS })) await register();
    },
  };
}

/** The switch in an extension page; `undefined` elsewhere (the web app, the tests). */
export function browserPasskeySwitch(): PasskeySwitch | undefined {
  const api = (globalThis as { chrome?: Partial<ScriptsApi> }).chrome;
  return api?.permissions && api.scripting ? passkeySwitch(api as ScriptsApi) : undefined;
}

interface WindowsApi {
  runtime: { getURL(path: string): string };
  windows: {
    create(options: {
      url: string;
      type: 'popup';
      width: number;
      height: number;
      focused: boolean;
    }): Promise<{ id?: number }>;
    remove(windowId: number): Promise<void>;
    onRemoved: { addListener(listener: (windowId: number) => void): void };
  };
}

/** The confirmation window, of the extension's origin, which the page can neither cover nor click. */
export function browserWindows(): ConfirmWindows | undefined {
  const api = (globalThis as { chrome?: Partial<WindowsApi> }).chrome;
  const { runtime, windows } = api ?? {};
  if (!runtime || !windows) return undefined;
  return {
    open: async (token) => {
      const created = await windows.create({
        url: runtime.getURL(`${CONFIRM_PAGE}#${token}`),
        type: 'popup',
        width: 420,
        height: 640,
        focused: true,
      });
      return created.id;
    },
    close: (windowId) => {
      // Already closed by the user: nothing to do.
      windows.remove(windowId).catch(() => undefined);
    },
    onRemoved: (listener) => {
      windows.onRemoved.addListener(listener);
    },
  };
}

/** A request's window token: 32 lowercase hexadecimal digits from the CSPRNG (§7.7). */
export function windowToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
