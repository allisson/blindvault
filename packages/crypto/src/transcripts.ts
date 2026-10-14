// Transcript inputs of crypto-spec.md §13: the Noise prologues, in layout encoding (D1, D10).

import { EncodingError } from './errors';
import { label, layout } from './layout';
import { lib } from './sodium';

const PAYLOAD_HASH_LENGTH = 32;
export const DTLS_FINGERPRINT_LENGTH = 32;

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
