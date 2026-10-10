// Spike encoding of the pairing payload (D4, D136): what an SDP needs, in compact binary, and the SDP
// rebuilt from it. Not the final format; it exists to measure size and interoperability.

export type Setup = 'actpass' | 'active' | 'passive';
export type CandidateKind = 'host-v4' | 'host-v6' | 'host-mdns' | 'srflx-v4' | 'srflx-v6';

export interface Candidate {
  kind: CandidateKind;
  address: string; // IPv4, IPv6 or "<uuid>.local"
  port: number;
}

export interface Payload {
  version: 1;
  offer: boolean;
  setup: Setup;
  lanOnly: boolean;
  cameraGranted: boolean;
  sessionId: Uint8Array; // 8 bytes
  fingerprint: Uint8Array; // SHA-256, 32 bytes
  ufrag: string;
  pwd: string;
  candidates: Candidate[];
}

const KINDS: CandidateKind[] = ['host-v4', 'host-v6', 'host-mdns', 'srflx-v4', 'srflx-v6'];
const SETUPS: Setup[] = ['actpass', 'active', 'passive'];

export interface ParsedSdp {
  setup: Setup;
  fingerprint: Uint8Array;
  ufrag: string;
  pwd: string;
  candidates: Candidate[];
  dropped: string[];
}

export function parseSdp(sdp: string): ParsedSdp {
  const lines = sdp.split(/\r?\n/);
  const attr = (name: string) => lines.find((l) => l.startsWith(`a=${name}:`))?.slice(name.length + 3).trim();
  const fp = attr('fingerprint');
  if (!fp?.toLowerCase().startsWith('sha-256 ')) throw new Error(`unsupported fingerprint: ${String(fp)}`);
  const fingerprint = Uint8Array.from(
    fp
      .slice(8)
      .split(':')
      .map((h) => parseInt(h, 16)),
  );
  const setup = attr('setup') as Setup | undefined;
  const ufrag = attr('ice-ufrag');
  const pwd = attr('ice-pwd');
  if (!setup || !SETUPS.includes(setup) || !ufrag || !pwd || fingerprint.length !== 32) {
    throw new Error('SDP missing setup, ICE credentials or fingerprint');
  }
  const candidates: Candidate[] = [];
  const dropped: string[] = [];
  for (const line of lines.filter((l) => l.startsWith('a=candidate:'))) {
    const parts = line.slice('a=candidate:'.length).split(' ');
    const [, component, transport, , address = '', port = '0', , type] = parts;
    if (component !== '1' || transport?.toLowerCase() !== 'udp' || (type !== 'host' && type !== 'srflx')) {
      dropped.push(line);
      continue;
    }
    const family = address.endsWith('.local') ? 'mdns' : address.includes(':') ? 'v6' : 'v4';
    if (type === 'srflx' && family === 'mdns') {
      dropped.push(line);
      continue;
    }
    const kind = `${type}-${family}` as CandidateKind;
    if (!candidates.some((c) => c.kind === kind && c.address === address && c.port === Number(port))) {
      candidates.push({ kind, address, port: Number(port) });
    }
  }
  return { setup, fingerprint, ufrag, pwd, candidates, dropped };
}

function ipv4Bytes(a: string): number[] {
  const parts = a.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !(p >= 0 && p <= 255))) throw new Error(`bad IPv4 ${a}`);
  return parts;
}

function ipv6Bytes(a: string): number[] {
  const [head = '', tail = ''] = a.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = a.includes('::') ? [...h, ...Array<string>(8 - h.length - t.length).fill('0'), ...t] : h;
  if (groups.length !== 8) throw new Error(`bad IPv6 ${a}`);
  return groups.flatMap((g) => {
    const n = parseInt(g, 16);
    return [n >> 8, n & 0xff];
  });
}

function ipv6String(b: Uint8Array): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((((b[i] ?? 0) << 8) | (b[i + 1] ?? 0)).toString(16));
  return groups.join(':');
}

function uuidBytes(name: string): number[] {
  const hex = name.replace(/\.local$/, '').replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`mDNS name is not a UUID: ${name}`);
  return Array.from({ length: 16 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

function uuidString(b: Uint8Array): string {
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}.local`;
}

function ascii(s: string): number[] {
  if (s.length > 255 || /[^\x21-\x7e]/.test(s)) throw new Error('ICE credential not printable ASCII');
  return [s.length, ...Array.from(s, (c) => c.charCodeAt(0))];
}

export function encodePayload(p: Payload): Uint8Array {
  const out: number[] = [p.version];
  out.push((p.offer ? 1 : 0) | (SETUPS.indexOf(p.setup) << 1) | (p.lanOnly ? 8 : 0) | (p.cameraGranted ? 16 : 0));
  out.push(...p.sessionId, ...p.fingerprint, ...ascii(p.ufrag), ...ascii(p.pwd));
  out.push(p.candidates.length);
  for (const c of p.candidates) {
    out.push(KINDS.indexOf(c.kind));
    if (c.kind.endsWith('v4')) out.push(...ipv4Bytes(c.address));
    else if (c.kind.endsWith('v6')) out.push(...ipv6Bytes(c.address));
    else out.push(...uuidBytes(c.address));
    out.push(c.port >> 8, c.port & 0xff);
  }
  return Uint8Array.from(out);
}

export function decodePayload(b: Uint8Array): Payload {
  let i = 0;
  const take = (n: number) => {
    if (i + n > b.length) throw new Error('payload truncated');
    const s = b.slice(i, i + n);
    i += n;
    return s;
  };
  const byte = () => take(1)[0] ?? 0;
  const str = () => String.fromCharCode(...take(byte()));
  const version = byte();
  if (version !== 1) throw new Error(`unknown payload version ${String(version)}`);
  const flags = byte();
  const setup = SETUPS[(flags >> 1) & 3];
  if (!setup) throw new Error('bad setup');
  const sessionId = take(8);
  const fingerprint = take(32);
  const ufrag = str();
  const pwd = str();
  const n = byte();
  const candidates: Candidate[] = [];
  for (let k = 0; k < n; k++) {
    const kind = KINDS[byte()];
    if (!kind) throw new Error('bad candidate kind');
    const address = kind.endsWith('v4')
      ? Array.from(take(4)).join('.')
      : kind.endsWith('v6')
        ? ipv6String(take(16))
        : uuidString(take(16));
    const port = (byte() << 8) | byte();
    candidates.push({ kind, address, port });
  }
  if (i !== b.length) throw new Error('trailing bytes in payload');
  return {
    version: 1,
    offer: (flags & 1) === 1,
    setup,
    lanOnly: (flags & 8) === 8,
    cameraGranted: (flags & 16) === 16,
    sessionId,
    fingerprint,
    ufrag,
    pwd,
    candidates,
  };
}

/** Rebuilds a data-channel-only SDP from a payload, with no trickle. */
export function buildSdp(p: Payload): RTCSessionDescriptionInit {
  const fp = Array.from(p.fingerprint, (x) => x.toString(16).padStart(2, '0').toUpperCase()).join(':');
  const sessionNumber = BigInt(
    '0x' + Array.from(p.sessionId.slice(0, 7), (x) => x.toString(16).padStart(2, '0')).join(''),
  ).toString();
  const lines = [
    'v=0',
    `o=- ${sessionNumber} 2 IN IP4 127.0.0.1`,
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    `a=ice-ufrag:${p.ufrag}`,
    `a=ice-pwd:${p.pwd}`,
    `a=fingerprint:sha-256 ${fp}`,
    `a=setup:${p.setup}`,
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
  ];
  p.candidates.forEach((c, idx) => {
    const host = c.kind.startsWith('host');
    const priority = (host ? 2130706431 : 1694498815) - idx;
    const extra = host ? '' : ' raddr 0.0.0.0 rport 0';
    lines.push(
      `a=candidate:${String(idx + 1)} 1 udp ${String(priority)} ${c.address} ${String(c.port)} typ ${host ? 'host' : 'srflx'}${extra} generation 0`,
    );
  });
  lines.push('a=end-of-candidates');
  return { type: p.offer ? 'offer' : 'answer', sdp: lines.join('\r\n') + '\r\n' };
}
