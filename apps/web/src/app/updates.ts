// The update flow on the page (overview §11, D63, D142, D152, D162, D191). The service worker stages
// an asset update and switches only when asked with its hash, which the page does once the user
// confirmed. A changed `sw.js` cannot be stopped, only detected: the vault locks in the very
// `updatefound` handler, and a warning stays until the user dismisses it.

export interface UpdateOffer {
  readonly version: string;
  /** The SHA-256 of the new asset manifest, to compare with the release outside the app. */
  readonly hash: string;
}

interface ActiveWorker {
  postMessage(message: unknown, transfer: Transferable[]): void;
}

/** The part of a `ServiceWorkerRegistration` the monitor uses. */
export interface WatchedRegistration {
  readonly active: ActiveWorker | null;
  readonly installing: unknown;
  readonly waiting: unknown;
  addEventListener(type: 'updatefound', listener: () => void): void;
  update(): Promise<unknown>;
}

export interface UpdateState {
  readonly offer: UpdateOffer | undefined;
  /** A changed `sw.js` was found while this window ran: no asset update is offered. */
  readonly changedWorker: boolean;
  /** The warning about it, until dismissed. */
  readonly warning: boolean;
}

export interface UpdateDeps {
  /** Locks the vault; synchronous, wiping key material before it returns. */
  readonly lock: () => void;
  readonly reload: () => void;
  /** Whether an update may be applied now (D152). */
  readonly allowed: () => boolean;
  /** How long to wait for the service worker's answer. */
  readonly timeoutMs?: number;
}

const HASH = /^[0-9a-f]{64}$/;
/** The service worker's rule for a version (public/sw.js). */
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

function offerOf(reply: unknown): UpdateOffer | undefined {
  if (typeof reply !== 'object' || reply === null) return undefined;
  const { type, version, hash } = reply as Record<string, unknown>;
  if (type !== 'available' || typeof version !== 'string' || typeof hash !== 'string') {
    return undefined;
  }
  return VERSION.test(version) && HASH.test(hash) ? { version, hash } : undefined;
}

export class UpdateMonitor {
  readonly #deps: UpdateDeps;
  #registration: WatchedRegistration | undefined;
  #state: UpdateState = { offer: undefined, changedWorker: false, warning: false };
  readonly #listeners = new Set<() => void>();

  constructor(deps: UpdateDeps) {
    this.#deps = deps;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getState = (): UpdateState => this.#state;

  #set(state: UpdateState): void {
    this.#state = state;
    for (const l of this.#listeners) l();
  }

  /**
   * Watches the app's registration. A new worker while one is active is a changed `sw.js`; the
   * first install is not.
   */
  watch(registration: WatchedRegistration): void {
    this.#registration = registration;
    registration.addEventListener('updatefound', () => {
      if (registration.active) this.#changed();
    });
    // The browser may have found it at navigation, before this listener existed.
    if (registration.active && (registration.installing || registration.waiting)) this.#changed();
  }

  #changed(): void {
    // First, with no await: the new worker can take over the window within milliseconds (D162).
    this.#deps.lock();
    this.#set({ offer: undefined, changedWorker: true, warning: true });
  }

  /** Dismisses the warning ("I verified, continue"); the change stays known. */
  acknowledge(): void {
    if (this.#state.warning) this.#set({ ...this.#state, warning: false });
  }

  /** At startup and whenever the app becomes visible: a changed `sw.js`, then an asset update. */
  look(): void {
    const registration = this.#registration;
    if (!registration) return;
    registration.update().catch(() => undefined);
    void this.#check(registration);
  }

  async #check(registration: WatchedRegistration): Promise<void> {
    const active = registration.active;
    if (!active || this.#state.changedWorker) return;
    const reply = await this.#ask(active, { type: 'check' });
    // A changed sw.js may have been found while the worker answered.
    if (this.getState().changedWorker) return;
    const offer = offerOf(reply);
    const current = this.#state.offer;
    if (offer?.hash === current?.hash && offer?.version === current?.version) return;
    this.#set({ ...this.#state, offer });
  }

  /** Locks, asks the service worker to switch to the offered hash, and reloads once it did. */
  async apply(): Promise<'applied' | 'refused'> {
    const offer = this.#state.offer;
    const active = this.#registration?.active;
    if (!offer || !active || this.#state.changedWorker || !this.#deps.allowed()) return 'refused';
    this.#deps.lock();
    const reply = await this.#ask(active, { type: 'apply', hash: offer.hash });
    const applied =
      typeof reply === 'object' &&
      reply !== null &&
      (reply as { type?: unknown }).type === 'applied';
    if (applied) {
      this.#deps.reload();
      return 'applied';
    }
    this.#set({ ...this.#state, offer: undefined });
    return 'refused';
  }

  #ask(worker: ActiveWorker, message: object): Promise<unknown> {
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      const finish = (value: unknown): void => {
        clearTimeout(timer);
        channel.port1.onmessage = null;
        channel.port1.close();
        resolve(value);
      };
      const timer = setTimeout(() => {
        finish(undefined);
      }, this.#deps.timeoutMs ?? 120_000);
      channel.port1.onmessage = ({ data }) => {
        finish(data);
      };
      worker.postMessage(message, [channel.port2]);
    });
  }
}
