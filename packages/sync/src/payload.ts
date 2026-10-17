// The pairing payload v1 (`pairing-protocol.md` §3): what the other device needs to rebuild this
// device's SDP, plus the session ID, the "holds a vault" flag, the supported formats and, from the
// initiator, the commitment to its nonce. Decoding is strict, so one payload has exactly one
// encoding; the decoded bytes are what the Noise prologue binds (`crypto-spec.md` §13).

import { Base45Error, decodeBase45, encodeBase45 } from './base45';
import {
  type Candidate,
  type CandidateKind,
  FieldReader,
  FieldWriter,
  type LinkFields,
  type Role,
  type Setup,
  equalBytes,
  linkFlags,
  readLinkFields,
  readLinkFlags,
  writeLinkFields,
} from './link-fields';

export type { Candidate, CandidateKind, Role, Setup };

export const PAYLOAD_VERSION = 1;

export interface Payload extends LinkFields {
  readonly holdsVault: boolean;
  /** Supported `recordFormatVersion`s, strictly ascending (D122). */
  readonly formatVersions: readonly number[];
  /** Supported `recordType`s, strictly ascending (D122). */
  readonly recordTypes: readonly number[];
  /** 32 bytes from the initiator, `null` from the responder. */
  readonly commitment: Uint8Array | null;
}

/**
 * What the receiver waits for: a first payload (from the initiator), or the answer to the session
 * it started.
 */
export type PayloadExpectation =
  { readonly role: 'initiator' } | { readonly role: 'responder'; readonly sessionId: Uint8Array };

/**
 * Why a payload was refused: `version` asks the user to update the app (§12); `wrong-role` and
 * `wrong-session` are a payload of the wrong step or of another session; `malformed` is the rest.
 */
export type PayloadRejection = 'version' | 'malformed' | 'wrong-role' | 'wrong-session';

export class PayloadError extends Error {
  override name = 'PayloadError';
  constructor(
    readonly reason: PayloadRejection,
    detail: string,
  ) {
    super(`pairing payload rejected (${reason}): ${detail}`);
  }
}

const COMMITMENT_LENGTH = 32;

const malformed = (detail: string) => new PayloadError('malformed', detail);

/** Encodes a payload, refusing one that decoding would reject. */
export function encodePayload(payload: Payload): Uint8Array {
  const w = new FieldWriter(malformed);
  w.u8(PAYLOAD_VERSION);
  w.u8(linkFlags(payload) | (payload.holdsVault ? 8 : 0));
  writeLinkFields(w, payload, malformed);
  for (const list of [payload.formatVersions, payload.recordTypes]) {
    w.u8(list.length);
    for (const value of list) w.u16(value);
  }
  if (payload.commitment) w.fixed(payload.commitment, COMMITMENT_LENGTH);

  const bytes = w.bytes();
  // The decoder holds the rules of §3.3 (setup and role, ranges, order, commitment): one place.
  parse(bytes);
  return bytes;
}

/** Decodes a payload under the rules of §3.3. Throws `PayloadError`. */
export function decodePayload(bytes: Uint8Array, expected: PayloadExpectation): Payload {
  const payload = parse(bytes);
  if (payload.role !== expected.role) {
    throw new PayloadError('wrong-role', `expected the ${expected.role}`);
  }
  if (expected.role === 'responder' && !equalBytes(payload.sessionId, expected.sessionId)) {
    throw new PayloadError('wrong-session', 'the answer is for another session');
  }
  return payload;
}

/** The payload as base45 text, for a QR code or copy/paste (§3.4). */
export function encodePayloadText(payload: Payload): string {
  return encodeBase45(encodePayload(payload));
}

/**
 * Decodes a payload from base45 text. Line breaks and tabs, which a text field or a chat may add,
 * are removed; spaces are kept, because they are base45 characters (§3.4).
 */
export function decodePayloadText(text: string, expected: PayloadExpectation): Payload {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase45(text.replace(/[\r\n\t]/g, ''));
  } catch (error) {
    if (error instanceof Base45Error) throw malformed('not base45');
    /* v8 ignore next */
    throw error;
  }
  return decodePayload(bytes, expected);
}

function parse(bytes: Uint8Array): Payload {
  const r = new FieldReader(bytes, malformed);
  const ascending = () => {
    const count = r.u8();
    if (count === 0) throw malformed('empty list');
    const list = Array.from({ length: count }, () => r.u16());
    if (list.some((value, k) => k > 0 && value <= (list[k - 1] ?? 0))) {
      throw malformed('list not strictly ascending');
    }
    return list;
  };

  if (bytes.length === 0) throw malformed('empty');
  const version = r.u8();
  if (version !== PAYLOAD_VERSION) {
    throw new PayloadError('version', `version ${String(version)}`);
  }
  const flags = r.u8();
  if (flags & 0xf0) throw malformed('reserved flag bit set');
  const { role, setup } = readLinkFlags(flags, malformed);
  const fields = readLinkFields(r, malformed);
  const formatVersions = ascending();
  const recordTypes = ascending();
  const commitment = role === 'initiator' ? r.take(COMMITMENT_LENGTH) : null;
  r.end();
  return {
    role,
    setup,
    holdsVault: (flags & 8) !== 0,
    ...fields,
    formatVersions,
    recordTypes,
    commitment,
  };
}
