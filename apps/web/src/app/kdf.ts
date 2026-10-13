// The Argon2id worker (architecture.md, D142, D191): one worker for the window, started at startup
// and never terminated, so no derivation after the first unlock loads its code again. The client of
// `packages/crypto` still sees one port per request, which it terminates when done.

import { type KdfPort, type KdfRequest } from '@blindvault/crypto';
import workerUrl from '@blindvault/crypto/kdf.worker?worker&url';

interface ScriptUrlPolicy {
  createScriptURL(input: string): unknown;
}

interface TrustedTypes {
  createPolicy(
    name: string,
    rules: { createScriptURL: (input: string) => string },
  ): ScriptUrlPolicy;
}

/** The policy's rule: only `expected` becomes a script URL, so it can vouch for nothing else (D83). */
export function onlyUrl(expected: string): (input: string) => string {
  return (input) => {
    if (input !== expected) throw new TypeError('not the Argon2id worker');
    return input;
  };
}

let policy: ScriptUrlPolicy | undefined;

/** The worker URL as a TrustedScriptURL where the CSP requires Trusted Types, else as is. */
function scriptUrl(): string {
  const factory = (globalThis as { trustedTypes?: TrustedTypes }).trustedTypes;
  if (!factory) return workerUrl;
  policy ??= factory.createPolicy('blindvault-kdf-worker', { createScriptURL: onlyUrl(workerUrl) });
  // The Worker constructor takes a TrustedScriptURL where the DOM types say string.
  return policy.createScriptURL(workerUrl) as string;
}

/** The part of a `Worker` the shared worker uses. */
export interface KdfWorker {
  postMessage(message: unknown, transfer: Transferable[]): void;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onerror: (() => void) | null;
}

function zeroPassword(message: unknown): void {
  if (typeof message === 'object' && message !== null && 'password' in message) {
    const { password } = message;
    if (password instanceof Uint8Array) password.fill(0);
  }
}

function zeroKey(data: unknown): void {
  if (typeof data === 'object' && data !== null && 'key' in data) {
    const { key } = data;
    if (key instanceof Uint8Array) key.fill(0);
  }
}

/** One request's view of the shared worker. `terminate()` releases the request, not the worker. */
class Lease implements KdfPort {
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  released = false;

  constructor(private readonly kdf: SharedKdf) {}

  postMessage(message: KdfRequest | null, transfer: ArrayBuffer[]): void {
    this.kdf.enqueue(this, message, transfer);
  }

  terminate(): void {
    this.released = true;
  }
}

/**
 * The window's one Argon2id worker, serving one request at a time. A request released before its
 * answer, by a lock, gets its key zeroed and dropped. A worker that fails is not replaced, since a
 * new one would load code (D142): every request fails until a reload.
 */
export class SharedKdf {
  readonly #worker: KdfWorker;
  #queue: Promise<void> = Promise.resolve();
  #current: { readonly lease: Lease; readonly done: () => void } | undefined;
  #failed = false;

  constructor(worker: KdfWorker) {
    this.#worker = worker;
    worker.onmessage = ({ data }) => {
      this.#answer(data);
    };
    worker.onerror = () => {
      this.#fail();
    };
  }

  /** A port for one request, as `packages/crypto` expects. */
  port(): KdfPort {
    return new Lease(this);
  }

  /** Resolves once the worker answered a request: its code and WebAssembly have loaded. */
  ready(): Promise<void> {
    return new Promise((resolve, reject) => {
      const lease = new Lease(this);
      lease.onmessage = () => {
        lease.terminate();
        resolve();
      };
      lease.onerror = () => {
        reject(new Error('The Argon2id worker failed to load.'));
      };
      // An empty request: the worker answers it with a refusal once its code runs.
      this.enqueue(lease, null, []);
    });
  }

  /** @internal Called by a lease. */
  enqueue(lease: Lease, message: KdfRequest | null, transfer: ArrayBuffer[]): void {
    this.#queue = this.#queue.then(
      () =>
        new Promise<void>((done) => {
          if (lease.released || this.#failed) {
            zeroPassword(message);
            if (!lease.released) lease.onerror?.();
            done();
            return;
          }
          this.#current = { lease, done };
          this.#worker.postMessage(message, transfer);
        }),
    );
  }

  #answer(data: unknown): void {
    const current = this.#current;
    this.#current = undefined;
    current?.done();
    const deliver = current && !current.lease.released ? current.lease.onmessage : null;
    if (deliver) deliver({ data });
    else zeroKey(data);
  }

  #fail(): void {
    this.#failed = true;
    const current = this.#current;
    this.#current = undefined;
    current?.done();
    if (current && !current.lease.released) current.lease.onerror?.();
  }
}

/** Starts the window's Argon2id worker; call it once, at startup. */
export function startKdfWorker(): SharedKdf {
  return new SharedKdf(new Worker(scriptUrl(), { type: 'module' }) as unknown as KdfWorker);
}
