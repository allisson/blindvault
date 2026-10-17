// The reconnection payload v1 (`sync-protocol.md` §4): what the peer needs to rebuild this device's
// SDP for one sync session, as one `Noise_K` message from this device's identity to the public key
// of the peer the user picked (D17, D213, D214). Only the version byte is in the clear. Decoding is
// strict, so one plaintext has exactly one encoding; the message `m`, as transmitted, is what
// `prologue_KK` binds (`crypto-spec.md` §13).

import {
  type DeviceIdentity,
  NoiseError,
  openNoiseK,
  reconnectionPrologue,
  sealNoiseK,
} from '@blindvault/crypto';

import { Base45Error, decodeBase45, encodeBase45 } from './base45';
import {
  FieldReader,
  FieldWriter,
  type LinkFields,
  equalBytes,
  linkFlags,
  readLinkFields,
  readLinkFlags,
  writeLinkFields,
} from './link-fields';
import type { PayloadExpectation } from './payload';

export const RECONNECTION_VERSION = 1;

// e (32) and the tag (16) around a plaintext of 85 to 714 bytes (§4.1): a shorter or longer `m` is
// no payload, so it is refused as malformed before any decryption (D214).
const NOISE_K_OVERHEAD = 32 + 16;
export const MIN_RECONNECTION_MESSAGE_LENGTH = NOISE_K_OVERHEAD + 85;
export const MAX_RECONNECTION_MESSAGE_LENGTH = NOISE_K_OVERHEAD + 714;

/** The plaintext of §4.1: the fields shared with the pairing payload, and nothing else. */
export type Reconnection = LinkFields;

/**
 * Why a payload was refused (§4.3): `version` asks the user to update the app; `not-from-peer` is a
 * payload that is not from the picked peer to this device, for this vault and role; `malformed` is
 * the rest, an answer for another session included.
 */
export type ReconnectionRejection = 'version' | 'not-from-peer' | 'malformed';

export class ReconnectionError extends Error {
  override name = 'ReconnectionError';
  constructor(
    readonly reason: ReconnectionRejection,
    detail: string,
  ) {
    super(`reconnection payload rejected (${reason}): ${detail}`);
  }
}

/**
 * What a payload is sealed and opened with: this device's identity, the public key of the peer the
 * user picked, from its Device record, and the vault's ID.
 */
export interface ReconnectionKeys {
  readonly identity: DeviceIdentity;
  readonly peerPublicKey: Uint8Array;
  readonly vaultId: Uint8Array;
}

/** A payload as transmitted: `m`, for `prologue_KK`, and the base45 text of `version ‖ m`. */
export interface SealedReconnection {
  readonly message: Uint8Array;
  readonly text: string;
}

const malformed = (detail: string) => new ReconnectionError('malformed', detail);

/** Encodes the plaintext of §4.1, refusing one that decoding would reject. */
export function encodeReconnection(reconnection: Reconnection): Uint8Array {
  const w = new FieldWriter(malformed);
  w.u8(linkFlags(reconnection));
  writeLinkFields(w, reconnection, malformed);
  const bytes = w.bytes();
  parse(bytes);
  return bytes;
}

/** Decodes the plaintext of §4.1 under the rules of §4.3. Throws `ReconnectionError`. */
export function decodeReconnection(bytes: Uint8Array, expected: PayloadExpectation): Reconnection {
  const reconnection = parse(bytes);
  if (reconnection.role !== expected.role) throw malformed(`expected the ${expected.role}`);
  if (expected.role === 'responder' && !equalBytes(reconnection.sessionId, expected.sessionId)) {
    throw malformed('the answer is for another session');
  }
  return reconnection;
}

/** Seals this device's payload to the peer, under `prologue_K` with this device's role (§4.2). */
export function sealReconnection(
  reconnection: Reconnection,
  keys: ReconnectionKeys,
): SealedReconnection {
  const message = sealNoiseK({
    identity: keys.identity,
    peerPublicKey: keys.peerPublicKey,
    prologue: reconnectionPrologue(keys.vaultId, reconnection.role),
    payload: encodeReconnection(reconnection),
  });
  const bytes = new Uint8Array(1 + message.length);
  bytes[0] = RECONNECTION_VERSION;
  bytes.set(message, 1);
  return { message, text: encodeBase45(bytes) };
}

/**
 * Opens the peer's payload from base45 text, in the order of §4.3: the text, the version, the length
 * of `m`, `Noise_K` under the expected role, then the plaintext. Line breaks and tabs are removed;
 * spaces are kept, because they are base45 characters.
 */
export function openReconnection(
  text: string,
  keys: ReconnectionKeys,
  expected: PayloadExpectation,
): { readonly reconnection: Reconnection; readonly message: Uint8Array } {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase45(text.replace(/[\r\n\t]/g, ''));
  } catch (error) {
    if (error instanceof Base45Error) throw malformed('not base45');
    /* v8 ignore next */
    throw error;
  }
  if (bytes.length === 0) throw malformed('empty');
  const version = bytes[0] ?? 0;
  if (version !== RECONNECTION_VERSION) {
    throw new ReconnectionError('version', `version ${String(version)}`);
  }
  const message = bytes.slice(1);
  if (
    message.length < MIN_RECONNECTION_MESSAGE_LENGTH ||
    message.length > MAX_RECONNECTION_MESSAGE_LENGTH
  ) {
    throw malformed('length of m');
  }
  let plaintext: Uint8Array;
  try {
    plaintext = openNoiseK({
      identity: keys.identity,
      peerPublicKey: keys.peerPublicKey,
      prologue: reconnectionPrologue(keys.vaultId, expected.role),
      message,
    });
  } catch (error) {
    if (error instanceof NoiseError) {
      throw new ReconnectionError('not-from-peer', 'not from the picked peer to this device');
    }
    throw error;
  }
  return { reconnection: decodeReconnection(plaintext, expected), message };
}

function parse(bytes: Uint8Array): Reconnection {
  const r = new FieldReader(bytes, malformed);
  const flags = r.u8();
  if (flags & 0xf8) throw malformed('reserved flag bit set');
  const { role, setup } = readLinkFlags(flags, malformed);
  const fields = readLinkFields(r, malformed);
  r.end();
  return { role, setup, ...fields };
}
