// The messages of a sync session over the Noise channel of `Noise_KK` (`sync-protocol.md` §5, §11,
// CRYPTO-INV-009), on the session shared with pairing (`channel-session.ts`): every message after
// the handshake is framed in the channel, decoded strictly, and `abort` ends the session on both
// sides with its reason (§11.2). The order of sections 6 to 10 is each stage's to check.

import { ChannelSession, SessionError, type SessionProtocol } from './channel-session';
import {
  type SyncAbortReason,
  type SyncMessage,
  decodeSyncMessage,
  encodeSyncMessage,
} from './sync-messages';
import { type Transport } from './transport';

/** Why a sync session ended: an abort reason, or `closed` when the link closed with no `abort`. */
export type SyncSessionFailure = SyncAbortReason | 'closed';

export class SyncError extends SessionError<SyncAbortReason> {
  override name = 'SyncError';
  constructor(reason: SyncSessionFailure, by: 'local' | 'remote', options?: ErrorOptions) {
    super(reason, by, `sync session ended (${reason}, ${by})`, options);
  }
}

const SYNC: SessionProtocol<SyncMessage, SyncAbortReason, SyncError> = {
  encode: encodeSyncMessage,
  decode: decodeSyncMessage,
  abort: (reason) => ({ t: 'abort', reason }),
  aborted: (message) => (message.t === 'abort' ? message.reason : undefined),
  error: (reason, by, options) => new SyncError(reason, by, options),
};

/**
 * The messages of one sync session, over the Noise channel of a completed `Noise_KK`. One reader at
 * a time: each stage reads the messages it expects.
 */
export class SyncSession extends ChannelSession<SyncMessage, SyncAbortReason, SyncError> {
  constructor(channel: Transport) {
    super(channel, SYNC);
  }
}
