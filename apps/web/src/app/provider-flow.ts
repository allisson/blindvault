// The Android provider window's request, from the shell's `provider-request` to its one
// `provider-result` (android.md §7.1, §7.4 to §7.7, D301, D303): it takes the vault over from the main
// window, waits for the unlock, shows who asks, and signs, saves or hands a password over only on the
// user's tap. An app's request is served only for a domain whose assetlinks.json binds it. Every way
// out answers once, then locks the vault, so the window holds no session after its answer.

import { type ItemView, type VaultSession, fieldUrl, matchingUrl } from '@blindvault/vault';

import { matchingLogins, searchLogins } from '../extension/host';
import { type Checked, TIMEOUT_DEFAULT, checkRequest, timeoutOf } from '../extension/passkey';
import { NOT_ALLOWED, carryOut, confirmState } from '../extension/passkey-confirm';
import { type ConfirmChoice, type ConfirmState, type Found, type Refusal } from '../extension/rpc';
import {
  type Caller,
  type ProviderOutcome,
  type ProviderRequest,
  type ProviderResult,
  bindableDomain,
  parseProviderRequest,
  providerResult,
} from '../platform/android-provider';
import { type ShellAnswer } from '../platform/android-bridge';
import { hex } from './ids';

/** What the flow needs of the window's controller. */
export interface ProviderApp {
  readonly status: { readonly kind: string; readonly session?: VaultSession };
  subscribe(listener: () => void): () => void;
  /** Takes the vault's Web Lock from the main window (D51). */
  takeOver(): Promise<void>;
  lock(): void;
}

/** The shell's answer to `provider-assetlinks` (§7.4, D303). */
export type Binding = 'bound' | 'unbound' | 'redirect' | 'network';

export interface ProviderShell {
  /** `provider-request`: the shell's answer, or a rejection when it refused. */
  request(): Promise<ShellAnswer>;
  /** `provider-assetlinks`: whether the domain's assetlinks.json binds the calling app. */
  assetlinks(domain: string): Promise<Binding>;
  /** `provider-result`: the shell answers Credential Manager and finishes the activity. */
  result(result: ProviderResult): void;
}

export interface ProviderFlowDeps {
  readonly app: ProviderApp;
  readonly shell: ProviderShell;
  readonly now: () => number;
}

/** A Login item a password request may hand over: it has a user name and a password (D303). */
export interface PasswordLogin {
  readonly itemId: string;
  readonly title: string;
  readonly userName: string;
}

/** Why an app gets nothing: the domains asked and the shell's last answer (§7.4). */
export interface Unbound {
  readonly domains: readonly string[];
  readonly binding: Exclude<Binding, 'bound'> | undefined;
}

export type ProviderState =
  | { readonly kind: 'loading' }
  /** An app's passkey request: its rpId's assetlinks.json is being checked, before the unlock. */
  | { readonly kind: 'binding'; readonly domain: string }
  /** An app's passkey request its rpId does not bind: the window says why, and Cancel ends it. */
  | { readonly kind: 'unbound'; readonly packageName: string; readonly unbound: Unbound }
  | { readonly kind: 'unlock' }
  /** No vault this window can open: none, corrupt, or one that needs another version. */
  | { readonly kind: 'no-vault' }
  | {
      readonly kind: 'confirm';
      readonly state: Exclude<ConfirmState, { kind: 'locked' }>;
      /** An app's package, shown in place of the site (§7.5, D303). */
      readonly app?: string;
      readonly busy: boolean;
      readonly note?: Refusal;
    }
  | {
      readonly kind: 'password';
      readonly caller: Caller;
      /** An app's search (§7.6); a browser lists the logins of its origin. */
      readonly query: string;
      readonly logins: readonly PasswordLogin[];
      readonly busy: boolean;
      readonly note?: Unbound | 'not-found';
    }
  | { readonly kind: 'ended' };

const CANCELLED: ProviderOutcome = { kind: 'cancelled' };

function text(view: ItemView, role: string): string | undefined {
  const value = view.item?.fields.find((f) => f.role === role)?.value;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The Login items found, those with a user name and a password. */
function passwordLogins(found: readonly Found[]): PasswordLogin[] {
  return found.flatMap((f) =>
    f.username !== undefined && f.fields.includes('password')
      ? [{ itemId: f.itemId, title: f.title, userName: f.username }]
      : [],
  );
}

/** The hosts of a login's `https:` URLs a domain could bind, each once, in order (§7.6, D303). */
function hostsOf(view: ItemView): string[] {
  const hosts: string[] = [];
  for (const field of view.item?.fields ?? []) {
    if (field.type !== 'url' || typeof field.value !== 'string') continue;
    const url = fieldUrl(field.value);
    if (url?.protocol !== 'https:' || url.port !== '') continue;
    if (bindableDomain(url.hostname) && !hosts.includes(url.hostname)) hosts.push(url.hostname);
  }
  return hosts;
}

export class ProviderFlow {
  readonly #deps: ProviderFlowDeps;
  #state: ProviderState = { kind: 'loading' };
  readonly #listeners = new Set<() => void>();
  #request: ProviderRequest | undefined;
  #checked: Checked | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #unsubscribe: (() => void) | undefined;
  #tookOver = false;
  #wasUnlocked = false;
  #query = '';

  constructor(deps: ProviderFlowDeps) {
    this.#deps = deps;
  }

  readonly getState = (): ProviderState => this.#state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Asks the shell for the request, checks it, and follows the vault from then on. */
  async start(): Promise<void> {
    let answer: ShellAnswer;
    try {
      answer = await this.#deps.shell.request();
    } catch {
      this.#end(NOT_ALLOWED);
      return;
    }
    const request = parseProviderRequest(answer);
    if (!request) {
      this.#end(NOT_ALLOWED);
      return;
    }
    if (request.kind === 'passkey') {
      // The checks of extension.md §7.2 on the origin the privileged browser set, or on an app's
      // https://<rpId> (§7.3, §7.5).
      const checked = checkRequest(request.call);
      if (!checked) {
        this.#end(NOT_ALLOWED);
        return;
      }
      this.#checked = checked;
    }
    this.#request = request;
    const time =
      request.kind === 'passkey' ? timeoutOf(request.call.options.timeout) : TIMEOUT_DEFAULT;
    this.#timer = setTimeout(() => {
      this.#end(CANCELLED);
    }, time);
    // An app's passkey: its rpId binds it before the unlock, so the user types nothing for an app
    // that is not bound (D303).
    if (request.kind === 'passkey' && request.caller.kind === 'app' && this.#checked) {
      const domain = this.#checked.rpId;
      this.#set({ kind: 'binding', domain });
      const binding = await this.#bind(domain);
      if (this.#state.kind === 'ended') return;
      if (binding !== 'bound') {
        this.#set({
          kind: 'unbound',
          packageName: request.caller.packageName,
          unbound: { domains: [domain], binding },
        });
        return;
      }
    }
    this.#unsubscribe = this.#deps.app.subscribe(() => {
      this.#follow();
    });
    this.#follow();
  }

  /** The window was told to end (Back, the screen turning off): a cancellation. */
  end(): void {
    this.#end(CANCELLED);
  }

  /** The user's choice: another authenticator, Cancel, or a passkey to use or save. */
  choose(choice: ConfirmChoice): void {
    if (this.#state.kind === 'ended') return;
    if (choice.choice === 'cancel') {
      this.#end(CANCELLED);
      return;
    }
    if (choice.choice === 'browser') {
      this.#end({ kind: 'browser' });
      return;
    }
    const state = this.#state;
    const session = this.#session();
    const request = this.#request;
    const checked = this.#checked;
    if (state.kind !== 'confirm' || state.busy || !session) return;
    if (request?.kind !== 'passkey' || !checked) return;
    this.#set({ ...state, busy: true });
    carryOut(session, request.call, checked, choice, {
      now: this.#deps.now,
      ...('clientDataHash' in request
        ? { clientDataHash: request.clientDataHash }
        : { clientOrigin: request.clientOrigin }),
    }).then(
      (result) => {
        if (typeof result !== 'string') {
          this.#end(result);
          return;
        }
        const now = this.#state;
        if (now.kind === 'confirm') this.#set({ ...now, busy: false, note: result });
      },
      () => {
        // The vault locked, or a write failed: the caller learns only that it was not allowed.
        this.#end(NOT_ALLOWED);
      },
    );
  }

  /** An app's password request: the search over the Login items (§7.6). */
  search(query: string): void {
    this.#query = query;
    this.#follow();
  }

  /**
   * The user's tap on a login of a password request: a browser's is checked again against its
   * origin; an app's is handed over only when the host of one of its `https:` URLs binds the app.
   */
  async pick(itemId: string): Promise<void> {
    const state = this.#state;
    const session = this.#session();
    if (state.kind !== 'password' || state.busy || !session) return;
    const view = session.items().find((v) => hex(v.id) === itemId);
    const listed = state.logins.some((l) => l.itemId === itemId);
    const userName = view && text(view, 'username');
    const password = view && text(view, 'password');
    if (!view || !listed || userName === undefined || password === undefined) {
      this.#set({ ...state, note: 'not-found' });
      return;
    }
    const { caller } = state;
    if (caller.kind === 'browser') {
      if (view.item && matchingUrl(view.item, `${caller.origin}/`) !== null) {
        this.#end({ kind: 'password', userName, password });
      } else {
        this.#set({ ...state, note: 'not-found' });
      }
      return;
    }
    this.#set({ ...state, busy: true });
    const domains = hostsOf(view);
    let binding: Binding | undefined;
    for (const domain of domains) {
      binding = await this.#bind(domain);
      if (this.#state.kind === 'ended') return;
      if (binding === 'bound') {
        // Read again after the wait: the item may have changed meanwhile.
        const now = this.#session()
          ?.items()
          .find((v) => hex(v.id) === itemId);
        const name = now && text(now, 'username');
        const secret = now && text(now, 'password');
        if (name === undefined || secret === undefined) break;
        this.#end({ kind: 'password', userName: name, password: secret });
        return;
      }
    }
    const now = this.#state;
    if (now.kind === 'password') {
      this.#set({
        ...now,
        busy: false,
        note: { domains, binding: binding === 'bound' ? undefined : binding },
      });
    }
  }

  async #bind(domain: string): Promise<Binding> {
    try {
      return await this.#deps.shell.assetlinks(domain);
    } catch {
      return 'network';
    }
  }

  #session(): VaultSession | undefined {
    const { status } = this.#deps.app;
    return status.kind === 'unlocked' ? status.session : undefined;
  }

  /** The window's state from the vault's status. */
  #follow(): void {
    if (this.#state.kind === 'ended') return;
    const request = this.#request;
    if (!request) return;
    const { kind } = this.#deps.app.status;
    const session = this.#session();
    if (kind === 'elsewhere') {
      // The user's choice of BlindVault in the system sheet is the gesture (§7.1); a second loss
      // means the main window took the vault back.
      if (this.#tookOver) {
        this.#end(CANCELLED);
        return;
      }
      this.#tookOver = true;
      this.#set({ kind: 'loading' });
      void this.#deps.app.takeOver();
      return;
    }
    if (session) {
      this.#wasUnlocked = true;
      this.#show(request, session);
      return;
    }
    if (kind === 'locked' || kind === 'unlocking') {
      // A lock after the unlock ends the request (§7.1).
      if (this.#wasUnlocked) {
        this.#end(CANCELLED);
        return;
      }
      this.#set({ kind: 'unlock' });
      return;
    }
    this.#set(kind === 'starting' || kind === 'busy' ? { kind: 'loading' } : { kind: 'no-vault' });
  }

  /** The request on the unlocked vault. */
  #show(request: ProviderRequest, session: VaultSession): void {
    const shown = this.#state;
    if (request.kind === 'password') {
      const items = session.items();
      const { caller } = request;
      // A browser's are the logins of its origin (extension.md §5); an app's, a search (§7.6).
      const found =
        caller.kind === 'browser'
          ? matchingLogins(items, `${caller.origin}/`)
          : searchLogins(items, this.#query);
      this.#set({
        kind: 'password',
        caller,
        query: this.#query,
        logins: passwordLogins(found),
        busy: shown.kind === 'password' && shown.busy,
        ...(shown.kind === 'password' && shown.note !== undefined ? { note: shown.note } : {}),
      });
      return;
    }
    const checked = this.#checked;
    if (!checked) return;
    // A vault read-only for its clock answers a create NotAllowedError (§7.1, D73).
    if (request.call.kind === 'create' && !session.writable) {
      this.#end(NOT_ALLOWED);
      return;
    }
    this.#set({
      kind: 'confirm',
      state: confirmState(session, request.call, checked),
      ...(request.caller.kind === 'app' ? { app: request.caller.packageName } : {}),
      busy: shown.kind === 'confirm' && shown.busy,
    });
  }

  #end(outcome: ProviderOutcome): void {
    if (this.#state.kind === 'ended') return;
    this.#set({ kind: 'ended' });
    clearTimeout(this.#timer);
    this.#unsubscribe?.();
    this.#deps.shell.result(providerResult(outcome, this.#request?.caller));
    // No session outlives the answer (§7.1).
    this.#deps.app.lock();
  }

  #set(state: ProviderState): void {
    this.#state = state;
    for (const l of this.#listeners) l();
  }
}
