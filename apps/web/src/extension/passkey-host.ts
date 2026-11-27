// The pending passkey request in the session host (extension.md §7.4, §7.7, D268, D288, D289): one
// at a time, a confirmation window named by its token, a timer, the lock and unlock, and the result
// sent in `passkey-answer`. The page's call waits on it; nothing is signed or written before the
// user's click in the window, which is the user presence.

import { type VaultSession } from '@blindvault/vault';

import { checkRequest, timeoutOf, type Checked } from './passkey';
import { NOT_ALLOWED, carryOut, confirmState } from './passkey-confirm';
import { type PasskeyRequest } from './passkey-options';
import { type ConfirmChoice, type ConfirmState, type PasskeyResult, type Refusal } from './rpc';

/** The confirmation window, as the browser opens and closes it. */
export interface ConfirmWindows {
  /** Opens `confirm.html#<token>`; the window's ID, or `undefined` when the browser refused. */
  open(token: string): Promise<number | undefined>;
  close(windowId: number): void;
  /** Calls `listener` when any window closes. */
  onRemoved(listener: (windowId: number) => void): void;
}

/** What the passkey requests need of the app. */
export interface PasskeyApp {
  readonly status: { readonly kind: string; readonly session?: VaultSession };
  subscribe(listener: () => void): () => void;
}

export interface PasskeyHostDeps {
  readonly app: PasskeyApp;
  readonly windows: ConfirmWindows;
  /** Sends `passkey-answer` to the service worker (§7.7 Route step 4). */
  readonly answer: (answer: PasskeyAnswer) => void;
  /** 32 lowercase hexadecimal digits from a CSPRNG. */
  readonly token: () => string;
  readonly now: () => number;
}

export interface PasskeyAnswer {
  readonly tabId: number;
  readonly frameId: number;
  readonly request: string;
  readonly result: PasskeyResult;
}

interface Pending {
  readonly request: PasskeyRequest;
  readonly checked: Checked;
  token: string;
  windowId: number | undefined;
  timer: ReturnType<typeof setTimeout>;
  /** A choice is being carried out: no second one. */
  busy: boolean;
}

const BROWSER: PasskeyResult = { kind: 'browser' };

function unlocked(app: PasskeyApp): VaultSession | undefined {
  return app.status.kind === 'unlocked' ? app.status.session : undefined;
}

export class PasskeyHost {
  readonly #deps: PasskeyHostDeps;
  #pending: Pending | undefined;

  constructor(deps: PasskeyHostDeps) {
    this.#deps = deps;
    deps.windows.onRemoved((windowId) => {
      // The user closed the window: the request ends (§7.7 Window).
      const p = this.#pending;
      if (p?.windowId === windowId) {
        p.windowId = undefined;
        this.#end(p, NOT_ALLOWED);
      }
    });
    let wasUnlocked = unlocked(deps.app) !== undefined;
    deps.app.subscribe(() => {
      const now = unlocked(deps.app) !== undefined;
      if (wasUnlocked !== now) this.#changed(now);
      wasUnlocked = now;
    });
  }

  /** Takes a request the session host has just acknowledged (§7.7 Route step 3). */
  start(request: PasskeyRequest): void {
    const answer = (result: PasskeyResult) => {
      this.#deps.answer({
        tabId: request.tabId,
        frameId: request.frameId,
        request: request.request,
        result,
      });
    };
    // One request at a time, from any tab (D289); another goes back to the browser, without a
    // window or the focus (P-04).
    if (this.#pending) {
      answer(BROWSER);
      return;
    }
    const checked = checkRequest(request);
    if (!checked) {
      answer(BROWSER);
      return;
    }
    const s = unlocked(this.#deps.app);
    // A create on a read-only vault goes to the browser at once (§7.4, D73).
    if (checked.kind === 'create' && s && !s.writable) {
      answer(BROWSER);
      return;
    }
    const p: Pending = {
      request,
      checked,
      token: this.#deps.token(),
      timer: setTimeout(() => {
        this.#end(p, NOT_ALLOWED);
      }, timeoutOf(request.options.timeout)),
      windowId: undefined,
      busy: false,
    };
    this.#pending = p;
    void this.#open(p);
  }

  /**
   * The page aborted the call it made from `tabId` and `frameId` (§7.7 Route): its request ends,
   * and the window closes, so no later Confirm writes a passkey the site never registered (P-03).
   * Another tab's or frame's request is left as it is.
   */
  cancel(tabId: number, frameId: number, request: string): void {
    const p = this.#pending;
    if (p?.request.tabId !== tabId || p.request.frameId !== frameId) return;
    if (p.request.request !== request) return;
    this.#end(p, NOT_ALLOWED);
  }

  /** What the window with `token` shows (§7.7 Window). */
  details(token: string): ConfirmState | 'not-found' {
    const p = this.#pending;
    if (p?.token !== token) return 'not-found';
    const s = unlocked(this.#deps.app);
    if (!s) return { kind: 'locked' };
    return confirmState(s, p.request, p.checked);
  }

  /** Carries out the user's choice in the window with `token`. */
  async choose(token: string, choice: ConfirmChoice): Promise<true | Refusal> {
    const p = this.#pending;
    if (p?.token !== token) return 'not-found';
    if (p.busy) return 'invalid';
    if (choice.choice === 'cancel') return this.#end(p, NOT_ALLOWED);
    if (choice.choice === 'browser') return this.#end(p, BROWSER);
    const s = unlocked(this.#deps.app);
    if (!s) return 'locked';
    if ((choice.choice === 'use') !== (p.request.kind === 'get')) return 'invalid';
    p.busy = true;
    let result: PasskeyResult | Refusal;
    try {
      result = await carryOut(s, p.request, p.checked, choice, { now: this.#deps.now });
    } catch {
      // The vault locked, or a write failed: the page learns only that it was not allowed.
      result = NOT_ALLOWED;
    } finally {
      p.busy = false;
    }
    if (typeof result === 'string') return result;
    return this.#end(p, result);
  }

  /** The vault locked or unlocked while a request waits. */
  #changed(nowUnlocked: boolean): void {
    const p = this.#pending;
    if (!p) return;
    // A lock ends the request (§7.4, §3.2).
    if (!nowUnlocked) {
      this.#end(p, NOT_ALLOWED);
      return;
    }
    const s = unlocked(this.#deps.app);
    if (p.checked.kind === 'create' && s && !s.writable) {
      this.#end(p, BROWSER);
      return;
    }
    // Once unlocked, the window opens again with the request, under a new token (§7.7).
    this.#closeWindow(p);
    p.token = this.#deps.token();
    void this.#open(p);
  }

  async #open(p: Pending): Promise<void> {
    const token = p.token;
    const windowId = await this.#deps.windows.open(token).catch(() => undefined);
    if (windowId === undefined) {
      if (this.#pending === p && p.token === token) this.#end(p, NOT_ALLOWED);
      return;
    }
    // The request ended, or the window was opened again, while the browser opened this one.
    if (this.#pending !== p || p.token !== token) {
      this.#deps.windows.close(windowId);
      return;
    }
    p.windowId = windowId;
  }

  #closeWindow(p: Pending): void {
    const windowId = p.windowId;
    p.windowId = undefined;
    if (windowId !== undefined) this.#deps.windows.close(windowId);
  }

  #end(p: Pending, result: PasskeyResult): true {
    if (this.#pending !== p) return true;
    this.#pending = undefined;
    clearTimeout(p.timer);
    this.#closeWindow(p);
    const { tabId, frameId, request } = p.request;
    this.#deps.answer({ tabId, frameId, request, result });
    return true;
  }
}
