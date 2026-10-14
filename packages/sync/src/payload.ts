// The pairing payload v1 (`pairing-protocol.md` §3): what the other device needs to rebuild this
// device's SDP, plus the session ID, the "holds a vault" flag, the supported formats and, from the
// initiator, the commitment to its nonce. Decoding is strict, so one payload has exactly one
// encoding; the decoded bytes are what the Noise prologue binds (`crypto-spec.md` §13).

import { Base45Error, decodeBase45, encodeBase45 } from './base45';

export const PAYLOAD_VERSION = 1;

export type Role = 'initiator' | 'responder';
export type Setup = 'actpass' | 'active' | 'passive';
export type CandidateKind = 'host-ipv4' | 'host-ipv6' | 'host-mdns' | 'srflx-ipv4' | 'srflx-ipv6';

/** A UDP ICE candidate of component 1 (§3.2). `address` is 4 bytes for IPv4, else 16. */
export interface Candidate {
  readonly kind: CandidateKind;
  readonly address: Uint8Array;
  readonly port: number;
}

export interface Payload {
  readonly role: Role;
  /** `actpass` for the initiator; `active` or `passive` for the responder. */
  readonly setup: Setup;
  readonly holdsVault: boolean;
  /** 16 bytes, random from the initiator; the responder repeats it. */
  readonly sessionId: Uint8Array;
  /** SHA-256 fingerprint of this device's DTLS certificate, 32 bytes. */
  readonly fingerprint: Uint8Array;
  readonly ufrag: string;
  readonly pwd: string;
  /** 1 to 8 candidates. */
  readonly candidates: readonly Candidate[];
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

const SETUPS: readonly Setup[] = ['actpass', 'active', 'passive'];
const KINDS: readonly CandidateKind[] = [
  'host-ipv4',
  'host-ipv6',
  'host-mdns',
  'srflx-ipv4',
  'srflx-ipv6',
];
const ADDRESS_LENGTH: Record<CandidateKind, number> = {
  'host-ipv4': 4,
  'host-ipv6': 16,
  'host-mdns': 16,
  'srflx-ipv4': 4,
  'srflx-ipv6': 16,
};
const ICE_CHARS = /^[A-Za-z0-9+/]*$/;
const MAX_CANDIDATES = 8;
const SESSION_ID_LENGTH = 16;
const FINGERPRINT_LENGTH = 32;
const COMMITMENT_LENGTH = 32;
const MIN_UFRAG = 4;
const MIN_PWD = 22;

const malformed = (detail: string) => new PayloadError('malformed', detail);

/** Encodes a payload, refusing one that decoding would reject. */
export function encodePayload(payload: Payload): Uint8Array {
  const out: number[] = [];
  const u8 = (n: number) => {
    if (!Number.isInteger(n) || n < 0 || n > 0xff) throw malformed('value out of range');
    out.push(n);
  };
  const u16 = (n: number) => {
    if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw malformed('value out of range');
    out.push(n >> 8, n & 0xff);
  };
  const fixed = (bytes: Uint8Array, length: number) => {
    if (bytes.length !== length) throw malformed('field of the wrong length');
    out.push(...bytes);
  };
  const ice = (text: string) => {
    if (!ICE_CHARS.test(text)) throw malformed('ICE credential outside the ICE characters');
    u8(text.length);
    for (let i = 0; i < text.length; i++) out.push(text.charCodeAt(i));
  };

  u8(PAYLOAD_VERSION);
  const setup = SETUPS.indexOf(payload.setup);
  u8((payload.role === 'responder' ? 1 : 0) | (setup << 1) | (payload.holdsVault ? 8 : 0));
  fixed(payload.sessionId, SESSION_ID_LENGTH);
  fixed(payload.fingerprint, FINGERPRINT_LENGTH);
  ice(payload.ufrag);
  ice(payload.pwd);
  u8(payload.candidates.length);
  for (const candidate of payload.candidates) {
    const kind = KINDS.indexOf(candidate.kind);
    if (kind < 0) throw malformed('unknown candidate kind');
    u8(kind);
    fixed(candidate.address, ADDRESS_LENGTH[candidate.kind]);
    u16(candidate.port);
  }
  for (const list of [payload.formatVersions, payload.recordTypes]) {
    u8(list.length);
    for (const value of list) u16(value);
  }
  if (payload.commitment) fixed(payload.commitment, COMMITMENT_LENGTH);

  const bytes = Uint8Array.from(out);
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
  if (expected.role === 'responder' && !equal(payload.sessionId, expected.sessionId)) {
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
  let i = 0;
  const take = (n: number) => {
    if (i + n > bytes.length) throw malformed('truncated');
    const out = bytes.slice(i, i + n);
    i += n;
    return out;
  };
  const u8 = () => take(1)[0] ?? 0;
  const u16 = () => (u8() << 8) | u8();
  const ice = (min: number) => {
    const text = String.fromCharCode(...take(u8()));
    if (text.length < min || !ICE_CHARS.test(text)) throw malformed('ICE credential');
    return text;
  };
  const ascending = () => {
    const count = u8();
    if (count === 0) throw malformed('empty list');
    const list = Array.from({ length: count }, u16);
    if (list.some((value, k) => k > 0 && value <= (list[k - 1] ?? 0))) {
      throw malformed('list not strictly ascending');
    }
    return list;
  };

  if (bytes.length === 0) throw malformed('empty');
  const version = u8();
  if (version !== PAYLOAD_VERSION) {
    throw new PayloadError('version', `version ${String(version)}`);
  }
  const flags = u8();
  if (flags & 0xf0) throw malformed('reserved flag bit set');
  const role: Role = flags & 1 ? 'responder' : 'initiator';
  const setup = SETUPS[(flags >> 1) & 3];
  if (!setup) throw malformed('setup 3');
  if ((role === 'initiator') !== (setup === 'actpass'))
    throw malformed('setup does not match the role');
  const sessionId = take(SESSION_ID_LENGTH);
  const fingerprint = take(FINGERPRINT_LENGTH);
  const ufrag = ice(MIN_UFRAG);
  const pwd = ice(MIN_PWD);
  const count = u8();
  if (count < 1 || count > MAX_CANDIDATES) throw malformed('candidate count');
  const candidates: Candidate[] = [];
  for (let k = 0; k < count; k++) {
    const kind = KINDS[u8()];
    if (!kind) throw malformed('unknown candidate kind');
    const address = take(ADDRESS_LENGTH[kind]);
    const port = u16();
    if (port === 0) throw malformed('port 0');
    candidates.push({ kind, address, port });
  }
  const formatVersions = ascending();
  const recordTypes = ascending();
  const commitment = role === 'initiator' ? take(COMMITMENT_LENGTH) : null;
  if (i !== bytes.length) throw malformed('bytes after the last field');
  return {
    role,
    setup,
    holdsVault: (flags & 8) !== 0,
    sessionId,
    fingerprint,
    ufrag,
    pwd,
    candidates,
    formatVersions,
    recordTypes,
    commitment,
  };
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, k) => value === b[k]);
}
