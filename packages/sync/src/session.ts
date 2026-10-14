// The messages of a pairing session over the Noise channel (`pairing-protocol.md` §10, §11):
// framed, decoded strictly, and ended by `abort`. Every failure ends the session on both sides at
// once: a local one sends `abort` with its reason and closes the channel; a received `abort` closes
// it; a closed or broken link, a frame that fails decryption included, ends it with no message.
// Once ended, every call rejects with the same `PairingError`.

import { FrameError, FrameReader, toFrames } from './frames';
import {
  type AbortReason,
  type Message,
  MessageError,
  decodeMessage,
  encodeMessage,
} from './messages';
import { type Transport, TransportClosedError } from './transport';

/** A session expires this long after its device generated its payload, unless both confirmed. */
export const SESSION_TIMEOUT_MS = 10 * 60 * 1000;
/** After both confirmations, a device waiting this long without a frame aborts (`expired`). */
export const IDLE_TIMEOUT_MS = 60 * 1000;

/** Why a session ended: an abort reason, or `closed` when the link closed with no `abort`. */
export type PairingFailure = AbortReason | 'closed';

export class PairingError extends Error {
  override name = 'PairingError';
  constructor(
    readonly reason: PairingFailure,
    /** `local`: this device ended the session; `remote`: the peer did, or the link failed. */
    readonly by: 'local' | 'remote',
    options?: ErrorOptions,
  ) {
    super(`pairing session ended (${reason}, ${by})`, options);
  }
}

export interface PairingSessionOptions {
  /** When the session expires, in ms since the epoch: `SESSION_TIMEOUT_MS` after this device generated its payload. */
  readonly expiresAt?: number;
}

/**
 * The protocol messages of one session, over the Noise channel of a finished handshake. One reader
 * at a time: each stage reads the messages it expects, in the order of §6, §8 and §9.
 */
export class PairingSession {
  private readonly frames = new FrameReader();
  private failure: PairingError | null = null;
  private onEnded!: (error: PairingError) => void;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private idle = false;
  private reading = false;
  /** A message read ahead after the link closed while no stage was reading. */
  private ahead: Promise<Message> | null = null;
  /** Resolves with the error once the session has ended, for whatever reason. */
  readonly ended = new Promise<PairingError>((resolve) => {
    this.onEnded = resolve;
  });

  constructor(
    private readonly channel: Transport,
    options: PairingSessionOptions = {},
  ) {
    // The link may close while no stage reads (the user looks at the SAS): read what is left, so
    // an `abort` still in flight ends the session with its reason, and any other message waits for
    // the next `receive()`.
    void channel.closed.then(() => {
      if (this.failure || this.reading || this.ahead) return;
      this.ahead = this.read();
      this.ahead.catch(() => undefined);
    });
    if (options.expiresAt !== undefined) {
      this.expiry = setTimeout(
        () => void this.abort('expired'),
        Math.max(0, options.expiresAt - Date.now()),
      );
    }
  }

  /** The error the session ended with, or `null` while it runs. */
  get error(): PairingError | null {
    return this.failure;
  }

  async send(message: Message): Promise<void> {
    if (this.failure) throw this.failure;
    try {
      for (const frame of toFrames(encodeMessage(message))) await this.channel.send(frame);
    } catch (error) {
      throw this.lost(error);
    }
  }

  /** The next message. A received `abort` ends the session and rejects with its reason. */
  async receive(): Promise<Message> {
    const ahead = this.ahead;
    if (ahead) {
      this.ahead = null;
      return ahead;
    }
    this.reading = true;
    try {
      return await this.read();
    } finally {
      this.reading = false;
    }
  }

  private async read(): Promise<Message> {
    for (;;) {
      if (this.failure) throw this.failure;
      let frame: Uint8Array;
      try {
        frame = await this.nextFrame();
      } catch (error) {
        throw this.lost(error);
      }
      let bytes: Uint8Array | null;
      try {
        bytes = this.frames.push(frame);
      } catch (error) {
        if (error instanceof FrameError) return this.refuse('protocol-error', error);
        /* v8 ignore next */
        throw error;
      }
      if (!bytes) continue;
      let message: Message;
      try {
        message = decodeMessage(bytes);
      } catch (error) {
        if (error instanceof MessageError) return this.refuse(error.reason, error);
        /* v8 ignore next */
        throw error;
      }
      if (message.t === 'abort') {
        const error = this.end(new PairingError(message.reason, 'remote'));
        this.channel.close();
        throw error;
      }
      return message;
    }
  }

  /**
   * Ends the session: sends `abort` with `reason` when the channel is still open, then closes it.
   * Resolves with the error the session ended with, which is an earlier one if it had already
   * ended.
   */
  async abort(reason: AbortReason, cause?: unknown): Promise<PairingError> {
    if (this.failure) return this.failure;
    const error = this.end(
      new PairingError(reason, 'local', cause === undefined ? undefined : { cause }),
    );
    try {
      for (const frame of toFrames(encodeMessage({ t: 'abort', reason }))) {
        await this.channel.send(frame);
      }
    } catch {
      // The link is already gone: the peer learns of the end from the close.
    }
    this.channel.close();
    return error;
  }

  /** Aborts with `reason`, then rejects with the session's error. */
  async refuse(reason: AbortReason, cause?: unknown): Promise<never> {
    throw await this.abort(reason, cause);
  }

  /**
   * Both devices confirmed the SAS: the session no longer expires, and from now on a wait of
   * `IDLE_TIMEOUT_MS` without a frame aborts (`expired`, §11).
   */
  bothConfirmed(): void {
    clearTimeout(this.expiry);
    this.idle = true;
  }

  /** Ends a finished session without an `abort`: the session's last message was sent or received. */
  close(): void {
    if (this.failure) return;
    this.end(new PairingError('closed', 'local'));
    this.channel.close();
  }

  private nextFrame(): Promise<Uint8Array> {
    if (!this.idle) return this.channel.receive();
    const timer = setTimeout(() => void this.abort('expired'), IDLE_TIMEOUT_MS);
    return this.channel.receive().finally(() => {
      clearTimeout(timer);
    });
  }

  /** The error for a failed send or receive: the session's own, or the link's close. */
  private lost(error: unknown): PairingError {
    if (this.failure) return this.failure;
    if (!(error instanceof TransportClosedError)) throw error;
    const failure = this.end(
      new PairingError('closed', error.by === 'local' ? 'local' : 'remote', { cause: error }),
    );
    this.channel.close();
    return failure;
  }

  private end(error: PairingError): PairingError {
    this.failure = error;
    clearTimeout(this.expiry);
    this.idle = false;
    this.onEnded(error);
    return error;
  }
}
