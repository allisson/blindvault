// The pending passkey request in the session host (extension.md §7.4, §7.7, D268, D288, D289): one
// at a time, a confirmation window named by its token, a timer, the lock and unlock, and the result
// sent in `passkey-answer`. The page's call waits on it; nothing is signed or written before the
// user's click in the window, which is the user presence.

import { COSE_ALGORITHM, createPasskey, signPasskeyAssertion } from '@blindvault/crypto';
import {
  type ItemView,
  type PasskeyValue,
  type VaultSession,
  passkeyUserName,
} from '@blindvault/vault';

import { hex } from '../app/ids';
import {
  type Checked,
  candidates,
  checkRequest,
  clientDataJSON,
  holders,
  holdsExcluded,
  saveTargets,
  timeoutOf,
  withPasskey,
} from './passkey';
import { type PasskeyRequest, toBase64url } from './passkey-options';
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

const NOT_ALLOWED: PasskeyResult = { kind: 'error', name: 'NotAllowedError' };
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
    // One request at a time, from any tab (D289).
    if (this.#pending) {
      answer(NOT_ALLOWED);
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

  /** What the window with `token` shows (§7.7 Window). */
  details(token: string): ConfirmState | 'not-found' {
    const p = this.#pending;
    if (p?.token !== token) return 'not-found';
    const s = unlocked(this.#deps.app);
    if (!s) return { kind: 'locked' };
    const { request, checked } = p;
    const origins = {
      origin: request.origin,
      ...(request.topOrigin === request.origin ? {} : { topOrigin: request.topOrigin }),
      rpId: checked.rpId,
    };
    const items = s.items();
    if (request.kind === 'get') {
      return {
        kind: 'get',
        ...origins,
        passkeys: candidates(items, checked.rpId, request.options.allowCredentials).map(
          ({ credentialId, title, userName }) => ({
            credentialId,
            title,
            ...(userName === undefined ? {} : { userName }),
          }),
        ),
      };
    }
    const { rp, user } = request.options;
    return {
      kind: 'create',
      ...origins,
      rpName: rp.name,
      userName: user.name,
      displayName: user.displayName,
      items: saveTargets(items, request.origin).map((view) => {
        const username = view.item.fields.find((f) => f.role === 'username')?.value;
        return {
          itemId: hex(view.id),
          title: view.item.title,
          ...(typeof username === 'string' && username !== '' ? { username } : {}),
        };
      }),
      replaces: holders(items, checked.rpId, user.id).length > 0,
    };
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
      result =
        choice.choice === 'use'
          ? await this.#get(p, s, choice.credentialId)
          : await this.#create(p, s, choice);
    } catch {
      // The vault locked, or a write failed: the page learns only that it was not allowed.
      result = NOT_ALLOWED;
    } finally {
      p.busy = false;
    }
    if (typeof result === 'string') return result;
    return this.#end(p, result);
  }

  async #get(p: Pending, s: VaultSession, credentialId: string): Promise<PasskeyResult | Refusal> {
    const { request, checked } = p;
    if (request.kind !== 'get') return 'invalid';
    const chosen = candidates(s.items(), checked.rpId, request.options.allowCredentials).find(
      (c) => c.credentialId === credentialId,
    );
    if (!chosen) return 'not-found';
    const data = clientDataJSON(request);
    const signed = await signPasskeyAssertion(chosen.value.privateKey, checked.rpId, data);
    return {
      kind: 'asserted',
      id: toBase64url(chosen.value.credentialId),
      clientDataJSON: toBase64url(data),
      authenticatorData: toBase64url(signed.authenticatorData),
      signature: toBase64url(signed.signature),
      userHandle: toBase64url(chosen.value.userHandle),
    };
  }

  async #create(
    p: Pending,
    s: VaultSession,
    choice: Exclude<ConfirmChoice, { choice: 'use' | 'browser' | 'cancel' }>,
  ): Promise<PasskeyResult | Refusal> {
    const { request, checked } = p;
    if (request.kind !== 'create' || checked.kind !== 'create') return 'invalid';
    const items = s.items();
    const target =
      choice.choice === 'save'
        ? saveTargets(items, request.origin).find((v) => hex(v.id) === choice.itemId)
        : undefined;
    if (choice.choice === 'save' && !target) return 'not-found';
    // Known only after the click, so a page learns from it only what the user allowed (§7.4).
    if (holdsExcluded(items, request.options.excludeCredentials ?? [])) {
      return { kind: 'error', name: 'InvalidStateError' };
    }
    const { user, rp } = request.options;
    const held = holders(items, checked.rpId, user.id);
    // A write that would touch a read-only item is not made at all (overview §6).
    if (!s.writable || held.some((v: ItemView) => v.readOnly !== undefined)) return NOT_ALLOWED;
    const created = await createPasskey(checked.rpId, checked.algorithm);
    try {
      const userName = passkeyUserName(user.name);
      const value: PasskeyValue = {
        privateKey: created.privateKey,
        credentialId: created.credentialId,
        rpId: checked.rpId,
        userHandle: user.id,
        ...(userName === undefined ? {} : { userName }),
        createdAt: this.#deps.now(),
      };
      // Every item holding the replaced passkey, the chosen one included, gets the new one.
      for (const view of held) {
        if (target && hex(view.id) === hex(target.id)) continue;
        await s.updateItem(view.id, withPasskey(view.item, value));
      }
      if (target) {
        await s.updateItem(target.id, withPasskey(target.item, value));
      } else {
        await s.createItem({
          templateId: 'login',
          templateVersion: 1,
          title: rp.name.trim() === '' ? checked.rpId : rp.name.trim(),
          fields: [
            ...(userName === undefined
              ? []
              : [{ type: 'text' as const, role: 'username', value: userName }]),
            { type: 'url', role: 'url', value: `https://${checked.rpId}` },
            { type: 'passkey', value },
          ],
          tags: [],
        });
      }
    } finally {
      created.privateKey.fill(0);
    }
    return {
      kind: 'created',
      id: toBase64url(created.credentialId),
      clientDataJSON: toBase64url(clientDataJSON(request)),
      attestationObject: toBase64url(created.attestationObject),
      authenticatorData: toBase64url(created.authenticatorData),
      publicKey: toBase64url(created.publicKey),
      publicKeyAlgorithm: COSE_ALGORITHM[checked.algorithm],
    };
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
