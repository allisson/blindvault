// The fields the pairing payload (`pairing-protocol.md` §3.1, §3.2) and the reconnection payload
// (`sync-protocol.md` §4.1, D214) share, with the same encodings and rules: the role and DTLS setup
// bits of `flags`, then the session ID, the DTLS fingerprint, the ICE credentials and the
// candidates. Each payload adds its own version, reserved bits and fields around them.

export type Role = 'initiator' | 'responder';
export type Setup = 'actpass' | 'active' | 'passive';
export type CandidateKind = 'host-ipv4' | 'host-ipv6' | 'host-mdns' | 'srflx-ipv4' | 'srflx-ipv6';

/** A UDP ICE candidate of component 1 (§3.2). `address` is 4 bytes for IPv4, else 16. */
export interface Candidate {
  readonly kind: CandidateKind;
  readonly address: Uint8Array;
  readonly port: number;
}

export interface LinkFields {
  readonly role: Role;
  /** `actpass` for the initiator; `active` or `passive` for the responder. */
  readonly setup: Setup;
  /** 16 bytes, random from the initiator; the responder repeats it. */
  readonly sessionId: Uint8Array;
  /** SHA-256 fingerprint of this device's DTLS certificate, 32 bytes. */
  readonly fingerprint: Uint8Array;
  readonly ufrag: string;
  readonly pwd: string;
  /** 1 to 8 candidates. */
  readonly candidates: readonly Candidate[];
}

type Malformed = (detail: string) => Error;

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
const MIN_UFRAG = 4;
const MIN_PWD = 22;

/** Writes bytes, refusing a value out of range with the payload's own `malformed` error. */
export class FieldWriter {
  readonly #out: number[] = [];
  readonly #malformed: Malformed;

  constructor(malformed: Malformed) {
    this.#malformed = malformed;
  }

  u8(n: number): void {
    if (!Number.isInteger(n) || n < 0 || n > 0xff) throw this.#malformed('value out of range');
    this.#out.push(n);
  }

  u16(n: number): void {
    if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw this.#malformed('value out of range');
    this.#out.push(n >> 8, n & 0xff);
  }

  fixed(bytes: Uint8Array, length: number): void {
    if (bytes.length !== length) throw this.#malformed('field of the wrong length');
    this.#out.push(...bytes);
  }

  ice(text: string): void {
    if (!ICE_CHARS.test(text)) throw this.#malformed('ICE credential outside the ICE characters');
    this.u8(text.length);
    for (let i = 0; i < text.length; i++) this.#out.push(text.charCodeAt(i));
  }

  bytes(): Uint8Array {
    return Uint8Array.from(this.#out);
  }
}

/** Reads bytes in order; anything past the end is `malformed`. */
export class FieldReader {
  readonly #bytes: Uint8Array;
  readonly #malformed: Malformed;
  #i = 0;

  constructor(bytes: Uint8Array, malformed: Malformed) {
    this.#bytes = bytes;
    this.#malformed = malformed;
  }

  take(n: number): Uint8Array {
    if (this.#i + n > this.#bytes.length) throw this.#malformed('truncated');
    const out = this.#bytes.slice(this.#i, this.#i + n);
    this.#i += n;
    return out;
  }

  u8(): number {
    return this.take(1)[0] ?? 0;
  }

  u16(): number {
    return (this.u8() << 8) | this.u8();
  }

  ice(min: number): string {
    const text = String.fromCharCode(...this.take(this.u8()));
    if (text.length < min || !ICE_CHARS.test(text)) throw this.#malformed('ICE credential');
    return text;
  }

  /** Refuses bytes after the last field. */
  end(): void {
    if (this.#i !== this.#bytes.length) throw this.#malformed('bytes after the last field');
  }
}

/** Bits 0 to 2 of `flags`: the role, then the DTLS setup. */
export function linkFlags(fields: Pick<LinkFields, 'role' | 'setup'>): number {
  return (fields.role === 'responder' ? 1 : 0) | (SETUPS.indexOf(fields.setup) << 1);
}

/** Reads bits 0 to 2 of `flags`: setup 3, and a setup that does not match the role, are refused. */
export function readLinkFlags(
  flags: number,
  malformed: Malformed,
): Pick<LinkFields, 'role' | 'setup'> {
  const role: Role = flags & 1 ? 'responder' : 'initiator';
  const setup = SETUPS[(flags >> 1) & 3];
  if (!setup) throw malformed('setup 3');
  if ((role === 'initiator') !== (setup === 'actpass')) {
    throw malformed('setup does not match the role');
  }
  return { role, setup };
}

/** Writes the session ID, the fingerprint, the ICE credentials and the candidates. */
export function writeLinkFields(w: FieldWriter, fields: LinkFields, malformed: Malformed): void {
  w.fixed(fields.sessionId, SESSION_ID_LENGTH);
  w.fixed(fields.fingerprint, FINGERPRINT_LENGTH);
  w.ice(fields.ufrag);
  w.ice(fields.pwd);
  w.u8(fields.candidates.length);
  for (const candidate of fields.candidates) {
    const kind = KINDS.indexOf(candidate.kind);
    if (kind < 0) throw malformed('unknown candidate kind');
    w.u8(kind);
    w.fixed(candidate.address, ADDRESS_LENGTH[candidate.kind]);
    w.u16(candidate.port);
  }
}

/** Reads what `writeLinkFields` writes, under the rules of `pairing-protocol.md` §3.3. */
export function readLinkFields(
  r: FieldReader,
  malformed: Malformed,
): Omit<LinkFields, 'role' | 'setup'> {
  const sessionId = r.take(SESSION_ID_LENGTH);
  const fingerprint = r.take(FINGERPRINT_LENGTH);
  const ufrag = r.ice(MIN_UFRAG);
  const pwd = r.ice(MIN_PWD);
  const count = r.u8();
  if (count < 1 || count > MAX_CANDIDATES) throw malformed('candidate count');
  const candidates: Candidate[] = [];
  for (let k = 0; k < count; k++) {
    const kind = KINDS[r.u8()];
    if (!kind) throw malformed('unknown candidate kind');
    const address = r.take(ADDRESS_LENGTH[kind]);
    const port = r.u16();
    if (port === 0) throw malformed('port 0');
    candidates.push({ kind, address, port });
  }
  return { sessionId, fingerprint, ufrag, pwd, candidates };
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, k) => value === b[k]);
}
