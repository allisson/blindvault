// Transcript inputs of crypto-spec.md §13: the Noise prologues, in layout encoding (D1, D10), and
// the pairing commitment and SAS of `pairing-protocol.md` §6 (D199).

import { EncodingError } from './errors';
import { label, layout } from './layout';
import { lib, randomBytes } from './sodium';

const PAYLOAD_HASH_LENGTH = 32;
export const DTLS_FINGERPRINT_LENGTH = 32;
export const PAIRING_NONCE_LENGTH = 32;
export const PAIRING_COMMITMENT_LENGTH = 32;
const HANDSHAKE_HASH_LENGTH = 64;
const SAS_HASH_LENGTH = 32;
const SAS_MODULUS = 1_000_000n;

function sized(value: Uint8Array, length: number, name: string): Uint8Array {
  if (value.length !== length) throw new EncodingError(`${name} is ${String(length)} bytes`);
  return value;
}

function fingerprint(value: Uint8Array): Uint8Array {
  if (value.length !== DTLS_FINGERPRINT_LENGTH) {
    throw new EncodingError('a DTLS fingerprint is 32 bytes');
  }
  return value;
}

/**
 * `prologue_XX = layout("bv.pairing.v1", BLAKE2b-256(payload_initiator),
 * BLAKE2b-256(payload_responder), dtlsFingerprint_initiator, dtlsFingerprint_responder)`: the
 * payloads are the decoded bytes exactly as exchanged, commitment included.
 */
export function pairingPrologue(
  payloadInitiator: Uint8Array,
  payloadResponder: Uint8Array,
  fingerprintInitiator: Uint8Array,
  fingerprintResponder: Uint8Array,
): Uint8Array {
  return layout(
    label('bv.pairing.v1'),
    lib().crypto_generichash(PAYLOAD_HASH_LENGTH, payloadInitiator, null),
    lib().crypto_generichash(PAYLOAD_HASH_LENGTH, payloadResponder, null),
    fingerprint(fingerprintInitiator),
    fingerprint(fingerprintResponder),
  );
}

/** `BLAKE2b-256(layout("bv.pairing.commit.v1", nonce_I))` */
export function pairingCommitment(nonce: Uint8Array): Uint8Array {
  return lib().crypto_generichash(
    PAIRING_COMMITMENT_LENGTH,
    layout(label('bv.pairing.commit.v1'), sized(nonce, PAIRING_NONCE_LENGTH, 'a pairing nonce')),
    null,
  );
}

/** The initiator's nonce, drawn before its payload, with the commitment the payload carries. */
export function pairingNonce(): { nonce: Uint8Array; commitment: Uint8Array } {
  const nonce = randomBytes(PAIRING_NONCE_LENGTH);
  return { nonce, commitment: pairingCommitment(nonce) };
}

/** Whether `nonce` opens `commitment`, compared with `sodium_memcmp`. */
export function checkPairingCommitment(commitment: Uint8Array, nonce: Uint8Array): boolean {
  sized(commitment, PAIRING_COMMITMENT_LENGTH, 'a pairing commitment');
  return lib().memcmp(pairingCommitment(nonce), commitment);
}

/**
 * The SAS: `u64(BLAKE2b-256(layout("bv.sas.v1", h, nonce_I, nonce_R))[0..8]) mod 1,000,000`, read
 * big-endian, as six decimal digits with leading zeros. Grouping it for display is the UI's.
 */
export function pairingSas(
  handshakeHash: Uint8Array,
  nonceInitiator: Uint8Array,
  nonceResponder: Uint8Array,
): string {
  const sasHash = lib().crypto_generichash(
    SAS_HASH_LENGTH,
    layout(
      label('bv.sas.v1'),
      sized(handshakeHash, HANDSHAKE_HASH_LENGTH, 'a handshake hash'),
      sized(nonceInitiator, PAIRING_NONCE_LENGTH, 'a pairing nonce'),
      sized(nonceResponder, PAIRING_NONCE_LENGTH, 'a pairing nonce'),
    ),
    null,
  );
  const value = new DataView(sasHash.buffer, sasHash.byteOffset, 8).getBigUint64(0);
  return (value % SAS_MODULUS).toString().padStart(6, '0');
}
