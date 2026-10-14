import { describe, expect, it } from 'vitest';

import { type Candidate, type Payload, encodePayload } from './payload';
import { SdpError, buildRemoteSdp, parseLocalSdp } from './sdp';

const FINGERPRINT = Array.from({ length: 32 }, (_, i) =>
  (0x80 + i).toString(16).toUpperCase(),
).join(':');
const fingerprintBytes = Uint8Array.from({ length: 32 }, (_, i) => 0x80 + i);
const UUID = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
const uuidBytes = Uint8Array.from(UUID.replace(/-/g, '').match(/../g) ?? [], (b) =>
  parseInt(b, 16),
);

/** A Chromium offer after gathering, with candidates the payload drops. */
const chromiumOffer = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=extmap-allow-mixed',
  'a=msid-semantic: WMS',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 203.0.113.7',
  'a=candidate:1467250027 1 udp 2122260223 192.168.1.20 54321 typ host generation 0 network-id 1',
  `a=candidate:3711 1 udp 2122194687 ${UUID}.local 50000 typ host generation 0 network-id 2`,
  'a=candidate:1 1 udp 2122129151 2001:db8::1 50001 typ host generation 0 network-id 3',
  'a=candidate:842163049 1 udp 1686052607 203.0.113.7 61000 typ srflx raddr 192.168.1.20 rport 54321 generation 0',
  'a=candidate:9 1 udp 1686052606 2001:db8:1::2:3 3478 typ srflx raddr :: rport 0 generation 0',
  'a=candidate:2 1 tcp 1518280447 192.168.1.20 9 typ host tcptype active generation 0',
  'a=candidate:3 1 udp 41885439 198.51.100.1 3478 typ relay raddr 203.0.113.7 rport 61000 generation 0',
  'a=candidate:4 1 udp 1845501695 198.51.100.2 5000 typ prflx raddr 192.168.1.20 rport 54321 generation 0',
  'a=candidate:5 2 udp 2122260222 192.168.1.20 54322 typ host generation 0',
  'a=candidate:6 1 udp 2122260223 192.168.1.20 54321 typ host generation 0',
  'a=candidate:7 1 udp 2122260223 fe80::1%en0 54323 typ host generation 0',
  'a=candidate:8 1 udp 2122260223 printer.local 54324 typ host generation 0',
  `a=candidate:10 1 udp 1686052607 ${UUID}.local 61001 typ srflx raddr 0.0.0.0 rport 0 generation 0`,
  'a=candidate:11 1 udp 2122260223 192.168.1.256 54325 typ host generation 0',
  'a=candidate:12 1 udp 2122260223 192.168.1.21 0 typ host generation 0',
  'a=candidate:13 1 udp 2122260223 192.168.1.22 65536 typ host generation 0',
  'a=candidate:14 1 udp 2122260223 1:2:3:4:5:6:7:8:9 54326 typ host generation 0',
  'a=candidate:15 1 udp 2122260223 ::ffff:1.2.3.4 54327 typ host generation 0',
  'a=candidate:16 1 udp 2122260223 1::2::3 54328 typ host generation 0',
  'a=candidate:17 1 udp 2122260223 1:2:3:4:5:6:7::8 54329 typ host generation 0',
  'a=candidate:18 1 udp 2122260223 192.168.1.23',
  'a=ice-ufrag:Lh7R',
  'a=ice-pwd:aB3+/cD4eF5gH6iJ7kL8mN9o',
  'a=ice-options:trickle',
  `a=fingerprint:sha-256 ${FINGERPRINT}`,
  'a=setup:actpass',
  'a=mid:0',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
  '',
].join('\r\n');

/** A Firefox answer: session-level fingerprint, uppercase UDP, end-of-candidates. */
const firefoxAnswer = [
  'v=0',
  'o=mozilla...THIS_IS_SDPARTA-99.0 7110531478473307394 0 IN IP4 0.0.0.0',
  's=-',
  't=0 0',
  'a=sendrecv',
  'a=fingerprint:sha-1 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33',
  `a=fingerprint:SHA-256 ${FINGERPRINT.toLowerCase()}`,
  'a=group:BUNDLE 0',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=candidate:0 1 UDP 2122252543 192.168.1.30 50123 typ host',
  'a=end-of-candidates',
  'a=ice-pwd:0123456789abcdef0123456789abcdef',
  'a=ice-ufrag:1a2b3c4d',
  'a=mid:0',
  'a=setup:passive',
  'a=sctp-port:5000',
  'a=max-message-size:1073741823',
  '',
].join('\n');

function sdpError(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof SdpError) return error.message;
    throw error;
  }
  throw new Error('expected an SdpError');
}

describe('local SDP → payload fields (pairing-protocol.md §3.2)', () => {
  it('keeps UDP host and srflx candidates of component 1, srflx first, without duplicates', () => {
    const local = parseLocalSdp(chromiumOffer);
    expect(local.setup).toBe('actpass');
    expect(local.ufrag).toBe('Lh7R');
    expect(local.pwd).toBe('aB3+/cD4eF5gH6iJ7kL8mN9o');
    expect(local.fingerprint).toEqual(fingerprintBytes);
    expect(local.candidates).toEqual<Candidate[]>([
      { kind: 'srflx-ipv4', address: Uint8Array.of(203, 0, 113, 7), port: 61000 },
      {
        kind: 'srflx-ipv6',
        address: Uint8Array.of(0x20, 0x01, 0x0d, 0xb8, 0, 1, 0, 0, 0, 0, 0, 0, 0, 2, 0, 3),
        port: 3478,
      },
      { kind: 'host-ipv4', address: Uint8Array.of(192, 168, 1, 20), port: 54321 },
      { kind: 'host-mdns', address: uuidBytes, port: 50000 },
      {
        kind: 'host-ipv6',
        address: Uint8Array.of(0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1),
        port: 50001,
      },
    ]);
  });

  it('reads a Firefox answer: session-level SHA-256 fingerprint in any case, setup passive', () => {
    const local = parseLocalSdp(firefoxAnswer);
    expect(local.setup).toBe('passive');
    expect(local.fingerprint).toEqual(fingerprintBytes);
    expect(local.ufrag).toBe('1a2b3c4d');
    expect(local.candidates).toEqual([
      { kind: 'host-ipv4', address: Uint8Array.of(192, 168, 1, 30), port: 50123 },
    ]);
  });

  it('keeps at most 8 candidates, the srflx ones first', () => {
    const hosts = Array.from(
      { length: 9 },
      (_, i) => `a=candidate:${String(i)} 1 udp 2122260223 10.0.0.${String(i + 1)} 5000 typ host`,
    );
    const sdp = [
      ...hosts,
      'a=candidate:20 1 udp 1686052607 203.0.113.7 61000 typ srflx raddr 10.0.0.1 rport 5000',
      'a=ice-ufrag:Lh7R',
      'a=ice-pwd:aB3+/cD4eF5gH6iJ7kL8mN9o',
      `a=fingerprint:sha-256 ${FINGERPRINT}`,
      'a=setup:actpass',
    ].join('\r\n');
    const { candidates } = parseLocalSdp(sdp);
    expect(candidates).toHaveLength(8);
    expect(candidates[0]?.kind).toBe('srflx-ipv4');
    expect(candidates.slice(1).map((c) => c.address[3])).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it.each([
    [
      'no usable candidate',
      (s: string) => s.replace(/^a=candidate:.*$/gm, 'a=candidate:1 1 tcp 1 10.0.0.1 9 typ host'),
    ],
    [
      'no SHA-256 fingerprint',
      (s: string) => s.replace(/a=fingerprint:sha-256/i, 'a=fingerprint:sha-384'),
    ],
    ['a SHA-256 fingerprint of 31 bytes', (s: string) => s.replace(':9F\r', '\r')],
    ['a SHA-256 fingerprint with a bad byte', (s: string) => s.replace(':9F\r', ':9G\r')],
    [
      'two different fingerprints',
      (s: string) => `${s}a=fingerprint:sha-256 ${'00:'.repeat(31)}00\r\n`,
    ],
    ['no setup', (s: string) => s.replace(/^a=setup:.*$/m, '')],
    ['an unknown setup', (s: string) => s.replace('a=setup:actpass', 'a=setup:holdconn')],
    ['no ufrag', (s: string) => s.replace(/^a=ice-ufrag:.*$/m, '')],
    ['two different pwds', (s: string) => `${s}a=ice-pwd:zzzzzzzzzzzzzzzzzzzzzzzz\r\n`],
  ])('refuses an SDP with %s', (_, change) => {
    expect(sdpError(() => parseLocalSdp(change(chromiumOffer)))).toBeTruthy();
  });

  it('accepts a value repeated identically, as at session and media level', () => {
    const sdp = `${chromiumOffer}a=setup:actpass\r\na=ice-ufrag:Lh7R\r\n`;
    expect(parseLocalSdp(sdp).setup).toBe('actpass');
  });
});

const offer: Payload = {
  role: 'initiator',
  setup: 'actpass',
  holdsVault: true,
  sessionId: Uint8Array.from({ length: 16 }, (_, i) => 0x40 + i),
  fingerprint: fingerprintBytes,
  ufrag: 'Lh7R',
  pwd: 'aB3+/cD4eF5gH6iJ7kL8mN9o',
  candidates: [
    { kind: 'srflx-ipv4', address: Uint8Array.of(203, 0, 113, 7), port: 61000 },
    {
      kind: 'srflx-ipv6',
      address: Uint8Array.of(0x20, 0x01, 0x0d, 0xb8, 0, 1, 0, 0, 0, 0, 0, 0, 0, 2, 0, 3),
      port: 3478,
    },
    { kind: 'host-ipv4', address: Uint8Array.of(192, 168, 1, 20), port: 54321 },
    {
      kind: 'host-ipv6',
      address: Uint8Array.of(0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1),
      port: 50001,
    },
    { kind: 'host-mdns', address: uuidBytes, port: 50000 },
  ],
  formatVersions: [1],
  recordTypes: [1, 2, 3, 4, 5, 6],
  commitment: new Uint8Array(32),
};

describe('payload → remote SDP (pairing-protocol.md §4)', () => {
  it('rebuilds a data-channel-only offer from an initiator payload', () => {
    expect(buildRemoteSdp(offer)).toEqual({
      type: 'offer',
      sdp: [
        'v=0',
        'o=- 18086151361676614 2 IN IP4 127.0.0.1',
        's=-',
        't=0 0',
        'a=group:BUNDLE 0',
        'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
        'c=IN IP4 0.0.0.0',
        'a=mid:0',
        'a=ice-ufrag:Lh7R',
        'a=ice-pwd:aB3+/cD4eF5gH6iJ7kL8mN9o',
        `a=fingerprint:sha-256 ${FINGERPRINT}`,
        'a=setup:actpass',
        'a=sctp-port:5000',
        'a=candidate:1 1 udp 1694498815 203.0.113.7 61000 typ srflx raddr 0.0.0.0 rport 0',
        'a=candidate:2 1 udp 1694498814 2001:db8:1:0:0:0:2:3 3478 typ srflx raddr 0.0.0.0 rport 0',
        'a=candidate:3 1 udp 2130706429 192.168.1.20 54321 typ host',
        'a=candidate:4 1 udp 2130706428 2001:db8:0:0:0:0:0:1 50001 typ host',
        `a=candidate:5 1 udp 2130706427 ${UUID}.local 50000 typ host`,
        'a=end-of-candidates',
        '',
      ].join('\r\n'),
    });
  });

  it('rebuilds an answer from a responder payload, with its setup', () => {
    const answer: Payload = { ...offer, role: 'responder', setup: 'active', commitment: null };
    const rebuilt = buildRemoteSdp(answer);
    expect(rebuilt.type).toBe('answer');
    expect(rebuilt.sdp).toContain('\r\na=setup:active\r\n');
  });

  it('round-trips: the rebuilt SDP parses back to the same network fields', () => {
    const local = parseLocalSdp(buildRemoteSdp(offer).sdp);
    const rebuilt: Payload = { ...offer, ...local };
    expect(encodePayload(rebuilt)).toEqual(encodePayload(offer));
  });
});
