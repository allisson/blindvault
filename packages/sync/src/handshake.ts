// The pairing handshake of `pairing-protocol.md` §5: Noise_XX over the transport, with the prologue
// of `crypto-spec.md` §13 binding both payloads and both DTLS fingerprints. Each handshake message
// is one transport message with an empty payload; after the third, every message travels inside
// the Noise channel. Trust comes only from the SAS confirmed on both devices (§6), never from a
// finished handshake.

import {
  type DeviceIdentity,
  type NoiseHandshake,
  NoiseError,
  deviceId,
  pairingPrologue,
  startNoiseXX,
} from '@blindvault/crypto';

import { noiseChannel } from './channel';
import { PayloadError, type Role, decodePayload } from './payload';
import { PairingSession } from './session';
import { type Transport, TransportClosedError } from './transport';

/**
 * Why a handshake, pairing or sync, failed: `closed`, the transport closed or broke (the peer may
 * have refused); `invalid`, a message or a payload this side refuses; `same-identity` (pairing
 * only), the peer's static key is this device's own.
 */
export type HandshakeFailure = 'closed' | 'invalid' | 'same-identity';

export class HandshakeError extends Error {
  override name = 'HandshakeError';
  constructor(
    readonly reason: HandshakeFailure,
    options?: ErrorOptions,
  ) {
    super(`handshake failed (${reason})`, options);
  }
}

export interface PairingHandshakeOptions {
  readonly role: Role;
  readonly identity: DeviceIdentity;
  /** The initiator's payload, the decoded bytes exactly as exchanged. */
  readonly payloadInitiator: Uint8Array;
  /** The responder's payload, the decoded bytes exactly as exchanged. */
  readonly payloadResponder: Uint8Array;
}

export interface PairingHandshake {
  /** The final handshake hash `h`, 64 bytes, for the SAS (§6) and re-admission (§9). */
  readonly handshakeHash: Uint8Array;
  readonly peerPublicKey: Uint8Array;
  /** `BLAKE2b-128(peerPublicKey)`. */
  readonly peerDeviceId: Uint8Array;
  /** The Noise channel; every later message goes through it. */
  readonly channel: Transport;
}

/**
 * Runs the handshake over `transport`. On any failure the transport is closed, the handshake state
 * is wiped and a `HandshakeError` is thrown. A failure during the handshake sends nothing, since
 * there is no channel yet and the peer learns of it from the close (§1); the peer's static key
 * equal to this device's own is found after it, and sends `abort` (`protocol-error`).
 */
export async function pairingHandshake(
  transport: Transport,
  options: PairingHandshakeOptions,
): Promise<PairingHandshake> {
  let handshake: NoiseHandshake | undefined;
  try {
    const initiator = decodePayload(options.payloadInitiator, { role: 'initiator' });
    const responder = decodePayload(options.payloadResponder, {
      role: 'responder',
      sessionId: initiator.sessionId,
    });
    const prologue = pairingPrologue(
      options.payloadInitiator,
      options.payloadResponder,
      initiator.fingerprint,
      responder.fingerprint,
    );
    const noise = startNoiseXX({
      initiator: options.role === 'initiator',
      prologue,
      identity: options.identity,
    });
    handshake = noise;

    const read = async () => {
      if (noise.readMessage(await transport.receive()).length !== 0) {
        throw new HandshakeError('invalid');
      }
    };
    if (options.role === 'initiator') {
      await transport.send(noise.writeMessage());
      await read();
      await transport.send(noise.writeMessage());
    } else {
      await read();
      await transport.send(noise.writeMessage());
      await read();
    }

    const result = noise.result;
    if (!result) throw new HandshakeError('invalid');
    const channel = noiseChannel(transport, result.transport);
    if (sameBytes(result.remoteStaticKey, options.identity.publicKey)) {
      // The channel is open: the peer learns why (§5, §10.3). Closing it wipes its keys.
      await new PairingSession(channel).abort('protocol-error');
      throw new HandshakeError('same-identity');
    }
    return {
      handshakeHash: result.handshakeHash,
      peerPublicKey: result.remoteStaticKey,
      peerDeviceId: deviceId(result.remoteStaticKey),
      channel,
    };
  } catch (error) {
    handshake?.destroy();
    transport.close();
    if (error instanceof HandshakeError) throw error;
    if (error instanceof TransportClosedError) throw new HandshakeError('closed', { cause: error });
    if (error instanceof NoiseError || error instanceof PayloadError) {
      throw new HandshakeError('invalid', { cause: error });
    }
    throw error;
  }
}

/** Public keys only: no secret, so no constant-time comparison is needed. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
