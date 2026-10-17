// Transcript inputs of crypto-spec.md §13: the Noise prologues, in layout encoding (D1, D10), the
// pairing commitment and SAS of `pairing-protocol.md` §6 (D199), the re-admission key confirmation
// of §9 (D29), and the reconnection payload's and the sync handshake's prologues of
// `sync-protocol.md` §4.2 and §5 (D213, D217).

import { EncodingError } from './errors';
import { type SymmetricKey, keyBytes } from './keys';
import { id, label, layout } from './layout';
import { lib, randomBytes } from './sodium';

const PAYLOAD_HASH_LENGTH = 32;
export const DTLS_FINGERPRINT_LENGTH = 32;
export const PAIRING_NONCE_LENGTH = 32;
export const PAIRING_COMMITMENT_LENGTH = 32;
const HANDSHAKE_HASH_LENGTH = 64;
const SAS_HASH_LENGTH = 32;
const SAS_MODULUS = 1_000_000n;
export const READMISSION_MAC_LENGTH = 32;

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

/**
 * `prologue_K = layout("bv.reconnect.v1", vaultId, role)`, `role` being the session role of the
 * reconnection payload's sender (`sync-protocol.md` §4.2, D213).
 */
export function reconnectionPrologue(
  vaultId: Uint8Array,
  role: 'initiator' | 'responder',
): Uint8Array {
  return layout(label('bv.reconnect.v1'), id(vaultId), label(role));
}

/**
 * `prologue_KK = layout("bv.sync.v1", BLAKE2b-256(reconnection_initiator),
 * BLAKE2b-256(reconnection_responder), dtlsFingerprint_initiator, dtlsFingerprint_responder)`: the
 * reconnection payloads are the `Noise_K` messages `m` exactly as transmitted (D217).
 */
export function syncPrologue(
  reconnectionInitiator: Uint8Array,
  reconnectionResponder: Uint8Array,
  fingerprintInitiator: Uint8Array,
  fingerprintResponder: Uint8Array,
): Uint8Array {
  return layout(
    label('bv.sync.v1'),
    lib().crypto_generichash(PAYLOAD_HASH_LENGTH, reconnectionInitiator, null),
    lib().crypto_generichash(PAYLOAD_HASH_LENGTH, reconnectionResponder, null),
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

/**
 * The re-admission key confirmation (D29):
 * `BLAKE2b-256(key = K_readmission, layout("bv.v1.readmission", role, h))`, `role` being the
 * sender's own.
 */
export function readmissionMac(
  key: SymmetricKey,
  role: 'initiator' | 'responder',
  handshakeHash: Uint8Array,
): Uint8Array {
  return lib().crypto_generichash(
    READMISSION_MAC_LENGTH,
    layout(
      label('bv.v1.readmission'),
      label(role),
      sized(handshakeHash, HANDSHAKE_HASH_LENGTH, 'a handshake hash'),
    ),
    keyBytes(key),
  );
}

/** Whether `mac` is the peer's for `role`, compared with `sodium_memcmp`. */
export function checkReadmissionMac(
  key: SymmetricKey,
  role: 'initiator' | 'responder',
  handshakeHash: Uint8Array,
  mac: Uint8Array,
): boolean {
  sized(mac, READMISSION_MAC_LENGTH, 'a re-admission MAC');
  const expected = readmissionMac(key, role, handshakeHash);
  try {
    return lib().memcmp(expected, mac);
  } finally {
    expected.fill(0);
  }
}
