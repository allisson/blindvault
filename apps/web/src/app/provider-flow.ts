// The Android provider window's request, from the shell's `provider-request` to its one
// `provider-result` (android.md §7.1, §7.5, §7.7, D301): it takes the vault over from the main window,
// waits for the unlock, shows who asks, and signs or saves only on the user's tap. Every way out
// answers once, then locks the vault, so the window holds no session after its answer.

import { type VaultSession } from '@blindvault/vault';

import { type Checked, checkRequest, timeoutOf } from '../extension/passkey';
import { NOT_ALLOWED, carryOut, confirmState } from '../extension/passkey-confirm';
import { type ConfirmChoice, type ConfirmState, type Refusal } from '../extension/rpc';
import {
  type ProviderOutcome,
  type ProviderRequest,
  type ProviderResult,
  parseProviderRequest,
  providerResult,
} from '../platform/android-provider';
import { type ShellAnswer } from '../platform/android-bridge';

/** What the flow needs of the window's controller. */
export interface ProviderApp {
  readonly status: { readonly kind: string; readonly session?: VaultSession };
  subscribe(listener: () => void): () => void;
  /** Takes the vault's Web Lock from the main window (D51). */
  takeOver(): Promise<void>;
  lock(): void;
}

export interface ProviderShell {
  /** `provider-request`: the shell's answer, or a rejection when it refused. */
  request(): Promise<ShellAnswer>;
  /** `provider-result`: the shell answers Credential Manager and finishes the activity. */
  result(result: ProviderResult): void;
}

export interface ProviderFlowDeps {
  readonly app: ProviderApp;
  readonly shell: ProviderShell;
  readonly now: () => number;
}

export type ProviderState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unlock' }
  /** No vault this window can open: none, corrupt, or one that needs another version. */
  | { readonly kind: 'no-vault' }
  | {
      readonly kind: 'confirm';
      readonly state: Exclude<ConfirmState, { kind: 'locked' }>;
      readonly busy: boolean;
      readonly note?: Refusal;
    }
  | { readonly kind: 'ended' };

const CANCELLED: ProviderOutcome = { kind: 'cancelled' };

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
    // The checks of extension.md §7.2 on the origin the privileged browser set (§7.3).
    const checked = request ? checkRequest(request.call) : undefined;
    if (!request || !checked) {
      this.#end(NOT_ALLOWED);
      return;
    }
    this.#request = request;
    this.#checked = checked;
    this.#timer = setTimeout(() => {
      this.#end(CANCELLED);
    }, timeoutOf(request.call.options.timeout));
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
    if (state.kind !== 'confirm' || state.busy || !session || !request || !checked) return;
    this.#set({ ...state, busy: true });
    carryOut(session, request.call, checked, choice, {
      now: this.#deps.now,
      clientDataHash: request.clientDataHash,
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

  #session(): VaultSession | undefined {
    const { status } = this.#deps.app;
    return status.kind === 'unlocked' ? status.session : undefined;
  }

  /** The window's state from the vault's status. */
  #follow(): void {
    if (this.#state.kind === 'ended') return;
    const request = this.#request;
    const checked = this.#checked;
    if (!request || !checked) return;
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
      // A vault read-only for its clock answers a create NotAllowedError (§7.1, D73).
      if (request.call.kind === 'create' && !session.writable) {
        this.#end(NOT_ALLOWED);
        return;
      }
      const shown = this.#state;
      this.#set({
        kind: 'confirm',
        state: confirmState(session, request.call, checked),
        busy: shown.kind === 'confirm' && shown.busy,
      });
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

  #end(outcome: ProviderOutcome): void {
    if (this.#state.kind === 'ended') return;
    this.#set({ kind: 'ended' });
    clearTimeout(this.#timer);
    this.#unsubscribe?.();
    this.#deps.shell.result(providerResult(outcome));
    // No session outlives the answer (§7.1).
    this.#deps.app.lock();
  }

  #set(state: ProviderState): void {
    this.#state = state;
    for (const l of this.#listeners) l();
  }
}
