// Nonces and SAS (`pairing-protocol.md` §6, D199): after the handshake R sends its nonce, then I
// reveals the nonce its payload committed to, and R checks it against the commitment. Both derive
// the six-digit SAS from the handshake hash and both nonces; the user compares it on the two
// devices. Each confirmation travels as `confirmed`; nothing else is accepted before both, so no
// key or MAC can arrive before them (§6.4, CRYPTO-INV-011).

import {
  PAIRING_NONCE_LENGTH,
  checkPairingCommitment,
  pairingSas,
  randomBytes,
} from '@blindvault/crypto';

import type { Message } from './messages';
import type { PairingSession } from './session';

export type NonceExchangeOptions =
  | {
      readonly role: 'initiator';
      readonly handshakeHash: Uint8Array;
      /** The nonce drawn with the commitment of this device's payload; wiped once used. */
      readonly nonce: Uint8Array;
    }
  | {
      readonly role: 'responder';
      readonly handshakeHash: Uint8Array;
      /** The commitment in the initiator's payload. */
      readonly commitment: Uint8Array;
    };

/** What the user answers when the SAS does not match, or when they stop. */
export type SasRejection = 'sas-mismatch' | 'cancelled';

/**
 * Exchanges the nonces in the order of §6.1 and returns the SAS to show. A message other than
 * `nonce`, or a nonce that does not open the commitment, aborts (`protocol-error`).
 */
export async function exchangeNonces(
  session: PairingSession,
  options: NonceExchangeOptions,
): Promise<SasStage> {
  const nonceOf = async (): Promise<Uint8Array> => {
    const message = await session.receive();
    if (message.t !== 'nonce') return session.refuse('protocol-error');
    return message.n;
  };

  let nonceInitiator: Uint8Array;
  let nonceResponder: Uint8Array;
  if (options.role === 'initiator') {
    nonceInitiator = options.nonce;
    try {
      nonceResponder = await nonceOf();
      await session.send({ t: 'nonce', n: nonceInitiator });
    } catch (error) {
      nonceInitiator.fill(0);
      throw error;
    }
  } else {
    nonceResponder = randomBytes(PAIRING_NONCE_LENGTH);
    await session.send({ t: 'nonce', n: nonceResponder });
    nonceInitiator = await nonceOf();
    if (!checkPairingCommitment(options.commitment, nonceInitiator)) {
      await session.refuse('protocol-error');
    }
  }
  const sas = pairingSas(options.handshakeHash, nonceInitiator, nonceResponder);
  nonceInitiator.fill(0);
  nonceResponder.fill(0);
  return new SasStage(session, sas);
}

/**
 * The SAS shown to the user, waiting for their answer. The peer's `confirmed` may arrive first; it
 * is read as soon as it comes, so a peer that sends anything else, or aborts, ends the session
 * while the SAS is still on screen (`PairingSession.ended`).
 */
export class SasStage {
  private answered = false;
  private readonly peer: Promise<void>;

  constructor(
    private readonly session: PairingSession,
    /** Six decimal digits, leading zeros included. */
    readonly sas: string,
  ) {
    this.peer = session.receive().then(async (message: Message) => {
      if (message.t !== 'confirmed') await session.refuse('protocol-error');
    });
    // Observed by confirm(), and through `session.ended` until then.
    this.peer.catch(() => undefined);
  }

  /**
   * The user said the SAS matches: sends `confirmed`, and resolves once the peer's `confirmed` is
   * in too. Rejects with the session's `PairingError` when it ended first.
   */
  async confirm(): Promise<void> {
    this.answer();
    await this.session.send({ t: 'confirmed' });
    await this.peer;
    this.session.bothConfirmed();
  }

  /** The user said the SAS does not match, or cancelled: aborts with that reason. */
  async reject(reason: SasRejection): Promise<void> {
    this.answer();
    await this.session.abort(reason);
  }

  private answer(): void {
    if (this.answered) throw new Error('the SAS was already answered');
    this.answered = true;
  }
}
