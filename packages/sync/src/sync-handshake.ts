// The sync handshake of `sync-protocol.md` §5 (CRYPTO-INV-008, D217): Noise_KK between two
// registered devices, each with its identity and the peer's public key from its Device record, under
// `prologue_KK` over both reconnection payloads as transmitted and both DTLS fingerprints. Each
// handshake message is one transport message with an empty payload; after the second, every
// message travels inside the Noise channel. A failure sends nothing: the peer learns of it from the
// close.

import {
  EncodingError,
  type DeviceIdentity,
  type NoiseHandshake,
  NoiseError,
  startNoiseKK,
  syncPrologue,
} from '@blindvault/crypto';

import { noiseChannel } from './channel';
import { HandshakeError } from './handshake';
import type { Role } from './payload';
import { type Transport, TransportClosedError } from './transport';

/** What `prologue_KK` binds of one side's reconnection payload. */
export interface SessionPayload {
  /** The `Noise_K` message `m` exactly as transmitted, without the version byte. */
  readonly message: Uint8Array;
  /** The DTLS fingerprint the payload carries. */
  readonly fingerprint: Uint8Array;
}

export interface SyncHandshakeOptions {
  readonly role: Role;
  readonly identity: DeviceIdentity;
  /** The peer's public key, from the peer's Device record. */
  readonly peerPublicKey: Uint8Array;
  /** I's payload, which I sent and R opened. */
  readonly initiator: SessionPayload;
  /** R's payload, which R sent and I opened. */
  readonly responder: SessionPayload;
}

export interface SyncHandshake {
  /** The final handshake hash `h`, 64 bytes. */
  readonly handshakeHash: Uint8Array;
  /** The Noise channel; every later message goes through it (CRYPTO-INV-009). */
  readonly channel: Transport;
}

/**
 * Runs `Noise_KK` over `transport`, I as initiator. On any failure the transport is closed, the
 * handshake state is wiped and a `HandshakeError` is thrown: `closed` when the link closed (the
 * peer may have refused), `invalid` when this side refused a message or its own inputs.
 */
export async function syncHandshake(
  transport: Transport,
  options: SyncHandshakeOptions,
): Promise<SyncHandshake> {
  let handshake: NoiseHandshake | undefined;
  try {
    const noise = startNoiseKK({
      initiator: options.role === 'initiator',
      identity: options.identity,
      peerPublicKey: options.peerPublicKey,
      prologue: syncPrologue(
        options.initiator.message,
        options.responder.message,
        options.initiator.fingerprint,
        options.responder.fingerprint,
      ),
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
    } else {
      await read();
      await transport.send(noise.writeMessage());
    }

    const result = noise.result;
    /* v8 ignore next */
    if (!result) throw new HandshakeError('invalid');
    return {
      handshakeHash: result.handshakeHash,
      channel: noiseChannel(transport, result.transport),
    };
  } catch (error) {
    handshake?.destroy();
    transport.close();
    if (error instanceof HandshakeError) throw error;
    if (error instanceof TransportClosedError) throw new HandshakeError('closed', { cause: error });
    if (error instanceof NoiseError || error instanceof EncodingError) {
      throw new HandshakeError('invalid', { cause: error });
    }
    throw error;
  }
}
