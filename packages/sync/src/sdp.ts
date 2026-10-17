// The bridge between the browser's SDP and the payloads (`pairing-protocol.md` §3.2, §4,
// `sync-protocol.md` §4.1). `parseLocalSdp` takes from this device's gathered description what a
// payload carries; `buildRemoteSdp` rebuilds the peer's description from the fields of its payload. The rebuilt SDP carries the
// peer's DTLS fingerprint, so the browser refuses any other certificate (`crypto-spec.md` §13).

import type { Candidate, LinkFields, Setup } from './link-fields';

export class SdpError extends Error {
  override name = 'SdpError';
}

/** The network fields of a payload, read from this device's local description. */
export interface LocalDescription {
  readonly setup: Setup;
  readonly fingerprint: Uint8Array;
  readonly ufrag: string;
  readonly pwd: string;
  readonly candidates: readonly Candidate[];
}

const MAX_CANDIDATES = 8;
const SETUPS: readonly string[] = ['actpass', 'active', 'passive'];
const UUID_NAME =
  /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/i;

/**
 * Reads the payload fields from a gathered local description. Keeps the UDP host and srflx
 * candidates of component 1, without duplicates, the srflx ones first so host addresses never push
 * them out, and at most 8 (§3.2). Throws `SdpError` when a field is missing or ambiguous, or when no
 * candidate is left.
 */
export function parseLocalSdp(sdp: string): LocalDescription {
  const lines = sdp.split(/\r?\n/);
  const values = (name: string) => [
    ...new Set(
      lines.filter((l) => l.startsWith(`a=${name}:`)).map((l) => l.slice(name.length + 3)),
    ),
  ];
  const single = (name: string) => {
    const [value, ...others] = values(name);
    if (value === undefined || others.length > 0) throw new SdpError(`expected one a=${name}`);
    return value;
  };

  const setup = single('setup');
  if (!SETUPS.includes(setup)) throw new SdpError('unknown DTLS setup');

  const sha256 = values('fingerprint')
    .map((value) => value.split(' '))
    .filter(([algorithm]) => algorithm?.toLowerCase() === 'sha-256');
  const [fingerprintLine, ...otherFingerprints] = sha256;
  if (!fingerprintLine || otherFingerprints.length > 0) {
    throw new SdpError('expected one SHA-256 fingerprint');
  }
  const fingerprint = parseFingerprint(fingerprintLine[1] ?? '');

  const srflx: Candidate[] = [];
  const host: Candidate[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (!line.startsWith('a=candidate:')) continue;
    const candidate = parseCandidate(line.slice('a=candidate:'.length));
    if (!candidate) continue;
    const key = `${candidate.kind} ${candidate.address.join('.')} ${String(candidate.port)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    (candidate.kind.startsWith('srflx') ? srflx : host).push(candidate);
  }
  const candidates = [...srflx, ...host].slice(0, MAX_CANDIDATES);
  if (candidates.length === 0) throw new SdpError('no usable ICE candidate');

  return {
    setup: setup as Setup,
    fingerprint,
    ufrag: single('ice-ufrag'),
    pwd: single('ice-pwd'),
    candidates,
  };
}

/** Rebuilds the peer's description from its payload: an offer from I, an answer from R (§4). */
export function buildRemoteSdp(payload: LinkFields): { type: 'offer' | 'answer'; sdp: string } {
  const fingerprint = Array.from(payload.fingerprint, (b) =>
    b.toString(16).padStart(2, '0').toUpperCase(),
  ).join(':');
  // Any number below 2^63 will do; 7 bytes of the session ID keep it stable for the session.
  const sessionNumber = BigInt(`0x${hex(payload.sessionId.slice(0, 7))}`).toString();
  const lines = [
    'v=0',
    `o=- ${sessionNumber} 2 IN IP4 127.0.0.1`,
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    'a=mid:0',
    `a=ice-ufrag:${payload.ufrag}`,
    `a=ice-pwd:${payload.pwd}`,
    `a=fingerprint:sha-256 ${fingerprint}`,
    `a=setup:${payload.setup}`,
    'a=sctp-port:5000',
  ];
  payload.candidates.forEach((candidate, index) => {
    const isHost = candidate.kind.startsWith('host');
    // Type preference 126 for host, 100 for srflx (RFC 8445 §5.1.2), in payload order.
    const priority = (isHost ? 2130706431 : 1694498815) - index;
    const type = isHost ? 'typ host' : 'typ srflx raddr 0.0.0.0 rport 0';
    lines.push(
      `a=candidate:${String(index + 1)} 1 udp ${String(priority)} ${addressText(candidate)} ${String(candidate.port)} ${type}`,
    );
  });
  lines.push('a=end-of-candidates', '');
  return { type: payload.role === 'initiator' ? 'offer' : 'answer', sdp: lines.join('\r\n') };
}

function parseFingerprint(text: string): Uint8Array {
  const bytes = text.split(':');
  if (bytes.length !== 32 || bytes.some((b) => !/^[0-9a-f]{2}$/i.test(b))) {
    throw new SdpError('malformed SHA-256 fingerprint');
  }
  return Uint8Array.from(bytes, (b) => parseInt(b, 16));
}

/** `foundation component transport priority address port typ type ...`; null when not carried. */
function parseCandidate(text: string): Candidate | null {
  const [, component, transport, , address = '', portText = '', typ, type] = text.split(' ');
  if (component !== '1' || transport?.toLowerCase() !== 'udp' || typ !== 'typ') return null;
  if (type !== 'host' && type !== 'srflx') return null;
  const port = /^\d{1,5}$/.test(portText) ? Number(portText) : 0;
  if (port < 1 || port > 65535) return null;
  const ipv4 = parseIpv4(address);
  if (ipv4) return { kind: `${type}-ipv4`, address: ipv4, port };
  const ipv6 = parseIpv6(address);
  if (ipv6) return { kind: `${type}-ipv6`, address: ipv6, port };
  const uuid = UUID_NAME.exec(address);
  if (uuid && type === 'host') {
    return { kind: 'host-mdns', address: fromHex(uuid.slice(1).join('')), port };
  }
  return null;
}

function parseIpv4(text: string): Uint8Array | null {
  const parts = text.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null;
  return Uint8Array.from(parts, Number);
}

/** Hex groups with at most one `::`; no zone index and no embedded IPv4, which are not carried. */
function parseIpv6(text: string): Uint8Array | null {
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groups = (s: string) => (s === '' ? [] : s.split(':'));
  const head = groups(halves[0] ?? '');
  const tail = groups(halves[1] ?? '');
  if (![...head, ...tail].every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...head, ...Array<string>(missing).fill('0'), ...tail];
  return Uint8Array.from(all.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 0xff]));
}

function addressText({ kind, address }: Candidate): string {
  if (kind === 'host-mdns') {
    const h = hex(address);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}.local`;
  }
  if (address.length === 4) return address.join('.');
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    groups.push((((address[i] ?? 0) << 8) | (address[i + 1] ?? 0)).toString(16));
  }
  return groups.join(':');
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(text: string): Uint8Array {
  return Uint8Array.from(text.match(/../g) ?? [], (b) => parseInt(b, 16));
}
