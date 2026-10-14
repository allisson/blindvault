// The transport under pairing and sync (overview §2, `pairing-protocol.md` §4 and §10): ordered,
// reliable binary messages between two devices. It authenticates nothing; trust comes only from
// the Noise handshake and the SAS above it (§8.2). Tests run the protocols over the in-memory
// transport (`memory.ts`); the app runs them over a WebRTC DataChannel (`webrtc.ts`).

/**
 * The longest message a transport carries: one Noise transport message, 65,535 bytes with its tag
 * (`pairing-protocol.md` §10.1). Longer messages are refused on sending and close the transport on
 * receipt, before anything reads them.
 */
export const MAX_MESSAGE_LENGTH = 65_535;

/** Who closed a transport: this side, the peer, or a failure of the link. */
export type ClosedBy = 'local' | 'remote' | 'error';

export class TransportError extends Error {
  override name = 'TransportError';
}

/** The transport is closed; `by` says how. Messages that arrived before stay readable. */
export class TransportClosedError extends TransportError {
  override name = 'TransportClosedError';
  constructor(readonly by: ClosedBy) {
    super(`transport closed (${by})`);
  }
}

/** A message longer than `MAX_MESSAGE_LENGTH` was not sent. The transport stays open. */
export class MessageTooLongError extends TransportError {
  override name = 'MessageTooLongError';
  constructor() {
    super('message too long');
  }
}

export interface Transport {
  /**
   * Sends one message, resolving once the transport has taken it. Rejects with
   * `MessageTooLongError` above `MAX_MESSAGE_LENGTH`, and with `TransportClosedError` once closed.
   */
  send(message: Uint8Array): Promise<void>;
  /**
   * The next message, in the order sent. Once the transport is closed, the messages that arrived
   * before a remote close or an error are still returned, then it rejects with
   * `TransportClosedError`; after a local close it rejects at once.
   */
  receive(): Promise<Uint8Array>;
  /** Closes both directions. Idempotent; the first cause is kept. */
  close(): void;
  /** Resolves with the cause once the transport is closed. */
  readonly closed: Promise<ClosedBy>;
}

/** Received messages and pending `receive()` calls, shared by the transports. */
export class Inbox {
  private readonly messages: Uint8Array[] = [];
  private readonly waiting: {
    resolve: (message: Uint8Array) => void;
    reject: (error: Error) => void;
  }[] = [];
  private closedBy: ClosedBy | null = null;
  // Assigned by the promise executor, which runs at once.
  private onClosed!: (by: ClosedBy) => void;
  readonly closed = new Promise<ClosedBy>((resolve) => {
    this.onClosed = resolve;
  });

  get state(): ClosedBy | null {
    return this.closedBy;
  }

  /** Queues a message, or hands it to the oldest pending `receive()`. Ignored once closed. */
  push(message: Uint8Array): void {
    if (this.closedBy) return;
    const next = this.waiting.shift();
    if (next) next.resolve(message);
    else this.messages.push(message);
  }

  receive(): Promise<Uint8Array> {
    const message = this.messages.shift();
    if (message) return Promise.resolve(message);
    if (this.closedBy) return Promise.reject(new TransportClosedError(this.closedBy));
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject });
    });
  }

  /**
   * Closes the inbox; returns false when it was already closed. A local close discards what was
   * not read; a remote close or an error keeps it readable.
   */
  close(by: ClosedBy): boolean {
    if (this.closedBy) return false;
    this.closedBy = by;
    if (by === 'local') this.messages.length = 0;
    for (const next of this.waiting.splice(0)) next.reject(new TransportClosedError(by));
    this.onClosed(by);
    return true;
  }
}
