// Delivery of the reconnection payload (`sync-protocol.md` §4.4, D215). The payload is defined apart
// from how it travels (D12): a delivery carries the bytes `version ‖ m` and nothing above it changes
// with the delivery. v1 has the manual delivery, base45 text shown as a QR code or copied, and read
// back or pasted; a mailbox (Nostr, ntfy) may implement the same interface after v1. A delivery may
// lose, duplicate, reorder or replay payloads, and carry anyone's bytes: `receiveReconnection` takes
// the first one that opens and reports the others, so a refusal never ends the session.

import type { PayloadExpectation } from './payload';
import {
  type Reconnection,
  ReconnectionError,
  type ReconnectionKeys,
  decodeReconnectionText,
  encodeReconnectionText,
  openReconnection,
} from './reconnect';

export interface PayloadDelivery {
  /** Delivers this device's payload, `version ‖ m`, to the peer. Rejects once closed. */
  send(payload: Uint8Array): Promise<void>;
  /**
   * Each payload delivered to this device, in the order it arrived, until the delivery closes. One
   * reader.
   */
  receive(): AsyncIterable<Uint8Array>;
  /** Ends the delivery: a pending `receive` finishes. Idempotent. */
  close(): void;
}

export class DeliveryClosedError extends Error {
  override name = 'DeliveryClosedError';
  constructor() {
    super('payload delivery closed');
  }
}

/** Payloads received and the reader waiting for the next one. */
class PayloadQueue {
  readonly #payloads: Uint8Array[] = [];
  #wake: (() => void) | null = null;
  #closed = false;

  get closed(): boolean {
    return this.#closed;
  }

  push(payload: Uint8Array): void {
    if (this.#closed) return;
    this.#payloads.push(payload.slice());
    this.#wake?.();
  }

  close(): void {
    this.#closed = true;
    this.#wake?.();
  }

  async *drain(): AsyncGenerator<Uint8Array> {
    for (;;) {
      const next = this.#payloads.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#wake = null;
    }
  }
}

/** The manual delivery: the user carries the payload as base45 text, by QR code or copy/paste. */
export interface ManualDelivery extends PayloadDelivery {
  /** This device's payload as text, to show as a QR code or to copy; `null` until it is sent. */
  readonly text: string | null;
  /**
   * The text read from the peer's QR code or pasted. Throws `ReconnectionError` `malformed` at once
   * for a text that is not base45 or is empty, delivering nothing. Ignored once closed.
   */
  submit(text: string): void;
}

export function manualDelivery(): ManualDelivery {
  const queue = new PayloadQueue();
  let text: string | null = null;
  return {
    get text() {
      return text;
    },
    send(payload) {
      if (queue.closed) return Promise.reject(new DeliveryClosedError());
      text = encodeReconnectionText(payload);
      return Promise.resolve();
    },
    submit(received) {
      if (queue.closed) return;
      queue.push(decodeReconnectionText(received));
    },
    receive: () => queue.drain(),
    close() {
      queue.close();
    },
  };
}

export type DeliveryDirection = 'a-to-b' | 'b-to-a';

export interface MemoryDeliveryOptions {
  /**
   * Sees every payload sent and returns the payloads to deliver in its place, in order: the same
   * payload, a changed one, none, several, or payloads held back or recorded from earlier calls.
   */
  readonly intercept?: (direction: DeliveryDirection, payload: Uint8Array) => readonly Uint8Array[];
}

export interface MemoryDeliveryPair {
  readonly a: PayloadDelivery;
  readonly b: PayloadDelivery;
  /** Delivers bytes nobody sent, as anyone who knows a mailbox topic could. */
  readonly inject: (direction: DeliveryDirection, payload: Uint8Array) => void;
}

/**
 * An in-memory delivery pair, standing for a mailbox in the protocol tests: what the session does
 * over it, it does over any delivery (D215).
 */
export function memoryDelivery(options: MemoryDeliveryOptions = {}): MemoryDeliveryPair {
  const toA = new PayloadQueue();
  const toB = new PayloadQueue();
  const target = (direction: DeliveryDirection) => (direction === 'a-to-b' ? toB : toA);
  const side = (own: PayloadQueue, direction: DeliveryDirection): PayloadDelivery => ({
    send(payload) {
      if (own.closed) return Promise.reject(new DeliveryClosedError());
      const copy = payload.slice();
      queueMicrotask(() => {
        const delivered = options.intercept ? options.intercept(direction, copy) : [copy];
        for (const each of delivered) target(direction).push(each);
      });
      return Promise.resolve();
    },
    receive: () => own.drain(),
    close() {
      own.close();
    },
  });
  return {
    a: side(toA, 'a-to-b'),
    b: side(toB, 'b-to-a'),
    inject: (direction, payload) => {
      target(direction).push(payload);
    },
  };
}

/**
 * Waits for the peer's payload on `delivery` and returns the first one that opens (§4.3, §4.4).
 * Each refused payload, a `version` included, goes to `onRefused` and the wait goes on; `null` once
 * the delivery closes without one. The session closes the delivery at its timeout (§12).
 */
export async function receiveReconnection(
  delivery: PayloadDelivery,
  keys: ReconnectionKeys,
  expected: PayloadExpectation,
  onRefused: (error: ReconnectionError) => void,
): Promise<{ readonly reconnection: Reconnection; readonly message: Uint8Array } | null> {
  for await (const payload of delivery.receive()) {
    try {
      return openReconnection(payload, keys, expected);
    } catch (error) {
      if (!(error instanceof ReconnectionError)) throw error;
      onRefused(error);
    }
  }
  return null;
}
