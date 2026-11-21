// The extension's version lock (extension.md §8.2, D270, D285): the last version and manifest hash
// the user confirmed, an installation setting in `localStorage` holding no vault data (as D209's
// STUN list). A running build that differs shows both before any vault opens. A first installation,
// with no vault yet, records them at once, trust on first use as on the web. This is transparency,
// not protection: a malicious version can skip it.

export interface Build {
  readonly version: string;
  /** The SHA-256 of the build's asset manifest, in hex. */
  readonly hash: string;
}

export type VersionLockState =
  | { readonly kind: 'checking' }
  | { readonly kind: 'confirmed' }
  | {
      readonly kind: 'changed';
      /** Unknown when nothing is recorded, or the record cannot be read, beside a vault. */
      readonly previous: Build | undefined;
      readonly running: Build;
    };

export const STORAGE_KEY = 'blindvault.extension.confirmed';

const HASH = /^[0-9a-f]{64}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

export function readBuild(text: string | null): Build | undefined {
  if (text === null) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null) return undefined;
    const { version, hash } = value as Record<string, unknown>;
    if (typeof version !== 'string' || typeof hash !== 'string') return undefined;
    return VERSION.test(version) && HASH.test(hash) ? { version, hash } : undefined;
  } catch {
    return undefined;
  }
}

export interface VersionLockDeps {
  readonly storage: Pick<Storage, 'getItem' | 'setItem'>;
  /** The running build; `undefined` where no asset manifest is served (the dev server). */
  readonly running: () => Promise<Build | undefined>;
  /** Whether this installation holds a vault, once the app knows. */
  readonly vaultExists: () => Promise<boolean>;
}

const CHECKING: VersionLockState = { kind: 'checking' };
const CONFIRMED: VersionLockState = { kind: 'confirmed' };

export class VersionLock {
  readonly #deps: VersionLockDeps;
  #state: VersionLockState = CHECKING;
  readonly #listeners = new Set<() => void>();

  constructor(deps: VersionLockDeps) {
    this.#deps = deps;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getState = (): VersionLockState => this.#state;

  #set(state: VersionLockState): void {
    this.#state = state;
    for (const l of this.#listeners) l();
  }

  async start(): Promise<void> {
    const running = await this.#deps.running();
    if (!running) {
      this.#set(CONFIRMED);
      return;
    }
    const previous = readBuild(this.#deps.storage.getItem(STORAGE_KEY));
    if (previous?.version === running.version && previous.hash === running.hash) {
      this.#set(CONFIRMED);
      return;
    }
    if (!previous && !(await this.#deps.vaultExists())) {
      this.#record(running);
      return;
    }
    this.#set({ kind: 'changed', previous, running });
  }

  /** The user's confirmation of the running build. */
  confirm(): void {
    if (this.#state.kind === 'changed') this.#record(this.#state.running);
  }

  #record(build: Build): void {
    this.#deps.storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: build.version, hash: build.hash }),
    );
    this.#set(CONFIRMED);
  }
}

/** The part of the controller that says whether a vault exists. */
export interface StartingApp {
  readonly status: { readonly kind: string };
  subscribe(listener: () => void): () => void;
}

/**
 * Whether a vault exists, read once the app leaves `starting`. Any status but `no-vault` counts as
 * one, so a vault the app cannot open yet still asks for the confirmation.
 */
export function vaultExists(app: StartingApp): Promise<boolean> {
  return new Promise((resolve) => {
    const settled = (): boolean => {
      if (app.status.kind === 'starting') return false;
      resolve(app.status.kind !== 'no-vault');
      return true;
    };
    if (settled()) return;
    const stop = app.subscribe(() => {
      if (settled()) stop();
    });
  });
}
