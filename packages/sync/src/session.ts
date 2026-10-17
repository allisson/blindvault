// The messages of a pairing session over the Noise channel (`pairing-protocol.md` §10, §11), on the
// session shared with sync (`channel-session.ts`): framed, decoded strictly, and ended by `abort`.

import {
  ChannelSession,
  IDLE_TIMEOUT_MS,
  SessionError,
  type SessionProtocol,
} from './channel-session';
import { type AbortReason, type Message, decodeMessage, encodeMessage } from './messages';
import { type Transport } from './transport';

export { IDLE_TIMEOUT_MS };

/** A session expires this long after its device generated its payload, unless both confirmed. */
export const SESSION_TIMEOUT_MS = 10 * 60 * 1000;

/** Why a session ended: an abort reason, or `closed` when the link closed with no `abort`. */
export type PairingFailure = AbortReason | 'closed';

export class PairingError extends SessionError<AbortReason> {
  override name = 'PairingError';
  constructor(reason: PairingFailure, by: 'local' | 'remote', options?: ErrorOptions) {
    super(reason, by, `pairing session ended (${reason}, ${by})`, options);
  }
}

export interface PairingSessionOptions {
  /** When the session expires, in ms since the epoch: `SESSION_TIMEOUT_MS` after this device generated its payload. */
  readonly expiresAt?: number;
}

const PAIRING: SessionProtocol<Message, AbortReason, PairingError> = {
  encode: encodeMessage,
  decode: decodeMessage,
  abort: (reason) => ({ t: 'abort', reason }),
  aborted: (message) => (message.t === 'abort' ? message.reason : undefined),
  error: (reason, by, options) => new PairingError(reason, by, options),
};

/**
 * The protocol messages of one pairing session, over the Noise channel of a finished handshake. One
 * reader at a time: each stage reads the messages it expects, in the order of §6, §8 and §9.
 */
export class PairingSession extends ChannelSession<Message, AbortReason, PairingError> {
  constructor(channel: Transport, options: PairingSessionOptions = {}) {
    super(channel, PAIRING, options);
  }

  /**
   * Both devices confirmed the SAS: the session no longer expires, and from now on a wait of
   * `IDLE_TIMEOUT_MS` without a frame aborts (`expired`, §11).
   */
  bothConfirmed(): void {
    clearTimeout(this.expiry);
    this.idle = true;
  }
}
