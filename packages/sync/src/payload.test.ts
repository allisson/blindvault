import { describe, expect, it } from 'vitest';

import vectors from '../test-vectors/pairing-v1.json' with { type: 'json' };
import {
  type Candidate,
  type CandidateKind,
  type Payload,
  PayloadError,
  type PayloadExpectation,
  decodePayload,
  decodePayloadText,
  encodePayload,
  encodePayloadText,
} from './payload';

const hex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));

interface VectorPayload {
  role: string;
  setup: string;
  holdsVault: boolean;
  sessionId: string;
  fingerprint: string;
  ufrag: string;
  pwd: string;
  candidates: { kind: string; address: string; port: number }[];
  formatVersions: number[];
  recordTypes: number[];
  commitment: string | null;
}

function payload(v: VectorPayload): Payload {
  return {
    role: v.role as Payload['role'],
    setup: v.setup as Payload['setup'],
    holdsVault: v.holdsVault,
    sessionId: hex(v.sessionId),
    fingerprint: hex(v.fingerprint),
    ufrag: v.ufrag,
    pwd: v.pwd,
    candidates: v.candidates.map((c): Candidate => ({
      kind: c.kind as CandidateKind,
      address: hex(c.address),
      port: c.port,
    })),
    formatVersions: v.formatVersions,
    recordTypes: v.recordTypes,
    commitment: v.commitment === null ? null : hex(v.commitment),
  };
}

function expectation(e: { role: string; sessionId?: string }): PayloadExpectation {
  return e.role === 'initiator'
    ? { role: 'initiator' }
    : { role: 'responder', sessionId: hex(e.sessionId ?? '') };
}

function reason(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof PayloadError) return error.reason;
    throw error;
  }
  throw new Error('expected a PayloadError');
}

const [offerVector, answerVector] = vectors.payloads.valid;
if (!offerVector || !answerVector) throw new Error('missing vectors');
const offer = payload(offerVector.payload);
const answer = payload(answerVector.payload);

describe('pairing payload v1 (pairing-protocol.md §3)', () => {
  describe('vectors', () => {
    it.each(vectors.payloads.valid)('encodes and decodes: $case', (v) => {
      const p = payload(v.payload);
      expect(encodePayload(p)).toEqual(hex(v.bytes));
      expect(encodePayloadText(p)).toBe(v.text);
      expect(decodePayload(hex(v.bytes), expectation(v.expect))).toEqual(p);
      expect(decodePayloadText(v.text, expectation(v.expect))).toEqual(p);
    });

    it.each(vectors.payloads.invalid)('rejects ($reason): $case', (v) => {
      expect(reason(() => decodePayload(hex(v.bytes), expectation(v.expect)))).toBe(v.reason);
    });
  });

  describe('encoding', () => {
    it('refuses what decoding would reject, so no invalid payload is ever shown', () => {
      const cases: Payload[] = [
        { ...offer, setup: 'active' },
        { ...answer, setup: 'actpass' },
        { ...offer, commitment: null },
        { ...answer, commitment: new Uint8Array(32) },
        { ...offer, commitment: new Uint8Array(31) },
        { ...offer, sessionId: new Uint8Array(15) },
        { ...offer, fingerprint: new Uint8Array(33) },
        { ...offer, ufrag: 'abc' },
        { ...offer, ufrag: 'a'.repeat(256) },
        { ...offer, pwd: 'é'.repeat(22) },
        { ...offer, candidates: [] },
        {
          ...offer,
          candidates: Array<Candidate>(9).fill({
            kind: 'host-ipv4',
            address: new Uint8Array(4),
            port: 1,
          }),
        },
        { ...offer, candidates: [{ kind: 'host-ipv4', address: new Uint8Array(16), port: 1 }] },
        { ...offer, candidates: [{ kind: 'host-ipv6', address: new Uint8Array(4), port: 1 }] },
        { ...offer, candidates: [{ kind: 'host-ipv4', address: new Uint8Array(4), port: 0 }] },
        { ...offer, candidates: [{ kind: 'host-ipv4', address: new Uint8Array(4), port: 65536 }] },
        { ...offer, candidates: [{ kind: 'host-ipv4', address: new Uint8Array(4), port: 1.5 }] },
        {
          ...offer,
          candidates: [{ kind: 'relay' as CandidateKind, address: new Uint8Array(4), port: 1 }],
        },
        { ...offer, formatVersions: [] },
        { ...offer, formatVersions: [2, 1] },
        { ...offer, formatVersions: [65536] },
        { ...offer, formatVersions: [-1] },
        { ...offer, recordTypes: Array.from({ length: 256 }, (_, i) => i) },
      ];
      for (const p of cases) expect(reason(() => encodePayload(p))).toBe('malformed');
    });
  });

  describe('text', () => {
    it('ignores line breaks and tabs, which a text field or a chat may add', () => {
      const text = encodePayloadText(offer);
      const broken = `${text.slice(0, 10)}\r\n${text.slice(10, 20)}\n\t${text.slice(20)}\n`;
      expect(decodePayloadText(broken, { role: 'initiator' })).toEqual(offer);
    });

    it('keeps spaces, which are base45 characters: a payload may start with one', () => {
      const text = encodePayloadText(answer);
      expect(text.startsWith(' ')).toBe(true);
      const expect_ = { role: 'responder', sessionId: answer.sessionId } as const;
      expect(decodePayloadText(text, expect_)).toEqual(answer);
      expect(reason(() => decodePayloadText(text.trim(), expect_))).toBe('malformed');
      expect(reason(() => decodePayloadText(`${text} `, expect_))).toBe('malformed');
    });

    it('rejects a text that is not base45 as malformed', () => {
      expect(reason(() => decodePayloadText('bb8', { role: 'initiator' }))).toBe('malformed');
      expect(reason(() => decodePayloadText('', { role: 'initiator' }))).toBe('malformed');
    });

    it('rejects a payload of another version as version, before anything else', () => {
      const bytes = encodePayload(offer);
      bytes[0] = 2;
      bytes[1] = 0xff;
      expect(
        reason(() => decodePayload(bytes, { role: 'responder', sessionId: offer.sessionId })),
      ).toBe('version');
    });
  });

  it('returns copies, so the caller cannot change the decoded payload through the input', () => {
    const bytes = encodePayload(offer);
    const decoded = decodePayload(bytes, { role: 'initiator' });
    bytes.fill(0);
    expect(decoded).toEqual(offer);
  });
});
