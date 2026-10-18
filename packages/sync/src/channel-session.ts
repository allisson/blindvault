// The messages of one session over the Noise channel, shared by pairing (`pairing-protocol.md` §10,
// §11) and sync (`sync-protocol.md` §11, §12): framed, decoded strictly, and ended by `abort`.
// Every failure ends the session on both sides at once: a local one sends `abort` with its reason
// and closes the channel; a received `abort` closes it; a closed or broken link, a frame that fails
// decryption included, ends it with no message. Once ended, every call rejects with the same error.
// Messages leave one at a time, so the frames of two never interleave, and `abort` leaves after the
// message being sent and before any other (D222).

import { FrameError, FrameReader, toFrames } from './frames';
import { MessageError, type MessageRejection } from './message-codec';
import { type Transport, TransportClosedError } from './transport';

/** After the stage that starts it, a device waiting this long without a frame aborts (`expired`). */
export const IDLE_TIMEOUT_MS = 60 * 1000;

/** The reasons a session aborts with on its own: a message refused, or a timeout. */
export type SessionReason = MessageRejection | 'expired';

/** Why a session ended: an abort reason, or `closed` when the link closed with no `abort`. */
export class SessionError<R extends string> extends Error {
  constructor(
    readonly reason: R | 'closed',
    /** `local`: this device ended the session; `remote`: the peer did, or the link failed. */
    readonly by: 'local' | 'remote',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** What a session needs of its protocol. */
export interface SessionProtocol<M, R extends string, E extends SessionError<R>> {
  readonly encode: (message: M) => Uint8Array;
  /** Throws `MessageError`. */
  readonly decode: (bytes: Uint8Array) => M;
  readonly abort: (reason: R | SessionReason) => M;
  /** The reason of an `abort` message, `undefined` for any other. */
  readonly aborted: (message: M) => R | SessionReason | undefined;
  readonly error: (
    reason: R | SessionReason | 'closed',
    by: 'local' | 'remote',
    options?: ErrorOptions,
  ) => E;
}

export interface ChannelSessionOptions {
  /** When the session expires, in ms since the epoch. */
  readonly expiresAt?: number;
}

/**
 * The protocol messages of one session, over the Noise channel of a finished handshake. One reader
 * at a time: each stage reads the messages it expects, in its protocol's order.
 */
export class ChannelSession<M, R extends string, E extends SessionError<R>> {
  private readonly frames = new FrameReader();
  private failure: E | null = null;
  private onEnded!: (error: E) => void;
  protected expiry: ReturnType<typeof setTimeout> | undefined;
  protected idle = false;
  private reading = false;
  /** The message being sent, then each one waiting: sends run one at a time. */
  private sending: Promise<void> = Promise.resolve();
  /** A message read ahead after the link closed while no stage was reading. */
  private ahead: Promise<M> | null = null;
  /** Resolves with the error once the session has ended, for whatever reason. */
  readonly ended = new Promise<E>((resolve) => {
    this.onEnded = resolve;
  });

  constructor(
    private readonly channel: Transport,
    private readonly protocol: SessionProtocol<M, R, E>,
    options: ChannelSessionOptions = {},
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
  get error(): E | null {
    return this.failure;
  }

  /**
   * Sends `message`, after every message whose send started before it; an `abort` started before it
   * sends none of it. Its encoding and frames are wiped once sent, since a message may hold a key
   * (D202); `message` itself stays the caller's to wipe.
   */
  async send(message: M): Promise<void> {
    if (this.failure) throw this.failure;
    const bytes = this.protocol.encode(message);
    const frames = toFrames(bytes);
    await this.queue(async () => {
      try {
        for (const frame of frames) await this.channel.send(frame);
      } catch (error) {
        throw await this.refused(error);
      } finally {
        bytes.fill(0);
        for (const frame of frames) frame.fill(0);
      }
    });
  }

  /** Runs `job` once every send before it has run. */
  private queue(job: () => Promise<void>): Promise<void> {
    const run = this.sending.then(job);
    this.sending = run.catch(() => undefined);
    return run;
  }

  /** The next message. A received `abort` ends the session and rejects with its reason. */
  async receive(): Promise<M> {
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

  private async read(): Promise<M> {
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
      let message: M;
      try {
        message = this.protocol.decode(bytes);
      } catch (error) {
        if (error instanceof MessageError) return await this.refuse(error.reason, error);
        /* v8 ignore next */
        throw error;
      } finally {
        // The decoded message holds copies: the joined bytes may hold a key (D202).
        bytes.fill(0);
      }
      const reason = this.protocol.aborted(message);
      if (reason !== undefined) {
        const error = this.end(this.protocol.error(reason, 'remote'));
        this.channel.close();
        throw error;
      }
      return message;
    }
  }

  /**
   * Ends the session: sends `last` when given, then `abort` with `reason`, when the channel is still
   * open, then closes it. Both leave after the message being sent, and nothing after them. Resolves
   * with the error the session ended with, which is an earlier one if it had already ended.
   */
  async abort(reason: R | SessionReason, cause?: unknown, last?: M): Promise<E> {
    if (this.failure) return this.failure;
    const error = this.end(
      this.protocol.error(reason, 'local', cause === undefined ? undefined : { cause }),
    );
    const messages = [...(last === undefined ? [] : [last]), this.protocol.abort(reason)];
    await this.queue(async () => {
      try {
        for (const message of messages) {
          for (const frame of toFrames(this.protocol.encode(message))) {
            await this.channel.send(frame);
          }
        }
      } catch {
        // The link is already gone: the peer learns of the end from the close.
      }
      this.channel.close();
    });
    return error;
  }

  /** Aborts with `reason`, then rejects with the session's error. */
  async refuse(reason: R | SessionReason, cause?: unknown): Promise<never> {
    throw await this.abort(reason, cause);
  }

  /** Ends a finished session without an `abort`: the session's last message was sent or received. */
  close(): void {
    if (this.failure) return;
    this.end(this.protocol.error('closed', 'local'));
    this.channel.close();
  }

  private nextFrame(): Promise<Uint8Array> {
    if (!this.idle) return this.channel.receive();
    const timer = setTimeout(() => void this.abort('expired'), IDLE_TIMEOUT_MS);
    return this.channel.receive().finally(() => {
      clearTimeout(timer);
    });
  }

  /**
   * The error for a send the link refused. When the peer closed it, the frames still to read may
   * hold its `abort`, whose reason stands over the close (§11.2).
   */
  private async refused(error: unknown): Promise<E> {
    if (this.failure) return this.failure;
    if (!(error instanceof TransportClosedError) || error.by === 'local') return this.lost(error);
    // A stage reading ends the session itself, with the peer's reason or the close.
    if (this.reading) return this.ended;
    const ahead = this.ahead ?? this.read();
    this.ahead = ahead;
    try {
      await ahead;
    } catch {
      // The session ended on what was left: its error is returned below.
    }
    // Read through the getter: the session may have ended while this waited.
    return this.error ?? this.lost(error);
  }

  /** The error for a failed send or receive: the session's own, or the link's close. */
  private lost(error: unknown): E {
    if (this.failure) return this.failure;
    if (!(error instanceof TransportClosedError)) throw error;
    const failure = this.end(
      this.protocol.error('closed', error.by === 'local' ? 'local' : 'remote', { cause: error }),
    );
    this.channel.close();
    return failure;
  }

  private end(error: E): E {
    this.failure = error;
    clearTimeout(this.expiry);
    this.idle = false;
    this.onEnded(error);
    return error;
  }
}
