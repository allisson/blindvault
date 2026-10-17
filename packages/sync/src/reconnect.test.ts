import {
  type DeviceIdentity,
  EncodingError,
  Keyring,
  generateDeviceIdentity,
  initCrypto,
  loadDeviceIdentity,
} from '@blindvault/crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import vectors from '../test-vectors/sync-v1.json' with { type: 'json' };
import type { Candidate, CandidateKind } from './link-fields';
import type { PayloadExpectation } from './payload';
import {
  MAX_RECONNECTION_MESSAGE_LENGTH,
  MIN_RECONNECTION_MESSAGE_LENGTH,
  type Reconnection,
  ReconnectionError,
  type ReconnectionKeys,
  decodeReconnection,
  decodeReconnectionText,
  encodeReconnection,
  encodeReconnectionText,
  openReconnection as openBytes,
  sealReconnection,
} from './reconnect';

beforeAll(initCrypto);

const hex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

const v = vectors.reconnection;
type DeviceName = keyof typeof v.devices;

interface VectorReconnection {
  role: string;
  setup: string;
  sessionId: string;
  fingerprint: string;
  ufrag: string;
  pwd: string;
  candidates: { kind: string; address: string; port: number }[];
}

function reconnection(p: VectorReconnection): Reconnection {
  return {
    role: p.role as Reconnection['role'],
    setup: p.setup as Reconnection['setup'],
    sessionId: hex(p.sessionId),
    fingerprint: hex(p.fingerprint),
    ufrag: p.ufrag,
    pwd: p.pwd,
    candidates: p.candidates.map((c): Candidate => ({
      kind: c.kind as CandidateKind,
      address: hex(c.address),
      port: c.port,
    })),
  };
}

function expectation(e: { role: string; sessionId?: string }): PayloadExpectation {
  return e.role === 'initiator'
    ? { role: 'initiator' }
    : { role: 'responder', sessionId: hex(e.sessionId ?? '') };
}

let devices: Record<DeviceName, DeviceIdentity>;
beforeAll(() => {
  const keyring = new Keyring();
  const load = (name: DeviceName) => {
    const d = v.devices[name];
    return loadDeviceIdentity(keyring, hex(d.publicKey), hex(d.staticSecret));
  };
  devices = { initiator: load('initiator'), responder: load('responder'), other: load('other') };
});

/** `receiver` opens with its own identity and the public key of `peer`, the device it picked. */
function keys(receiver: string, peer: string): ReconnectionKeys {
  return {
    identity: devices[receiver as DeviceName],
    peerPublicKey: devices[peer as DeviceName].publicKey,
    vaultId: hex(v.vaultId),
  };
}

function reason(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ReconnectionError) return error.reason;
    throw error;
  }
  throw new Error('expected a ReconnectionError');
}

/** Opens a payload from its text, as the manual delivery and then the session do. */
function openReconnection(text: string, k: ReconnectionKeys, expected: PayloadExpectation) {
  return openBytes(decodeReconnectionText(text), k, expected);
}

/** Seals a payload and gives its text, as the manual delivery shows it. */
function seal(r: Reconnection, k: ReconnectionKeys) {
  const sealed = sealReconnection(r, k);
  return { ...sealed, text: encodeReconnectionText(sealed.bytes) };
}

const [offerVector, , answerVector] = v.valid;
if (!offerVector || !answerVector) throw new Error('missing vectors');
const offer = reconnection(offerVector.payload);
const answer = reconnection(answerVector.payload);

describe('reconnection payload v1 (sync-protocol.md §4, D213, D214)', () => {
  it('bounds m by the shortest and longest plaintext of §4.1', () => {
    expect([MIN_RECONNECTION_MESSAGE_LENGTH, MAX_RECONNECTION_MESSAGE_LENGTH]).toEqual([
      v.minMessageLength,
      v.maxMessageLength,
    ]);
  });

  describe('vectors', () => {
    it.each(v.valid)('encodes and opens: $case', (c) => {
      const p = reconnection(c.payload);
      expect(toHex(encodeReconnection(p))).toBe(c.plaintext);
      expect(decodeReconnection(hex(c.plaintext), expectation(c.expect))).toEqual(p);
      const opened = openReconnection(c.text, keys(c.receiver, c.sender), expectation(c.expect));
      expect(opened.reconnection).toEqual(p);
      expect(toHex(opened.message)).toBe(c.message);
    });

    it.each(v.invalid)('refuses ($reason): $case', (c) => {
      expect(
        reason(() => openReconnection(c.text, keys(c.receiver, c.peer), expectation(c.expect))),
      ).toBe(c.reason);
    });
  });

  describe('sealing', () => {
    it('seals to the peer, who opens it with this device as the picked peer', () => {
      const sealed = seal(offer, keys('initiator', 'responder'));
      const opened = openReconnection(sealed.text, keys('responder', 'initiator'), {
        role: 'initiator',
      });
      expect(opened.reconnection).toEqual(offer);
      expect(opened.message).toEqual(sealed.message);
      expect(sealed.bytes).toEqual(Uint8Array.from([1, ...sealed.message]));
      expect(sealed.message.length).toBe(hex(offerVector.message).length);
    });

    it('draws a new ephemeral key for each payload, so no two texts are the same', () => {
      const one = seal(answer, keys('responder', 'initiator'));
      const two = seal(answer, keys('responder', 'initiator'));
      expect(one.text).not.toBe(two.text);
      const expected = { role: 'responder', sessionId: answer.sessionId } as const;
      for (const s of [one, two]) {
        expect(
          openReconnection(s.text, keys('initiator', 'responder'), expected).reconnection,
        ).toEqual(answer);
      }
    });

    it('binds the role: a payload handed back to its own sender is refused', () => {
      const sealed = seal(offer, keys('initiator', 'responder'));
      const expected = { role: 'responder', sessionId: offer.sessionId } as const;
      expect(
        reason(() => openReconnection(sealed.text, keys('initiator', 'responder'), expected)),
      ).toBe('not-from-peer');
    });

    it('binds the vault: a payload sealed for another vault is refused, the same one opens', () => {
      const vaultId = hex(v.vaultId);
      const otherVault = vaultId.map((b) => b ^ 1);
      const from = keys('initiator', 'responder');
      const to = keys('responder', 'initiator');
      const sealed = seal(offer, { ...from, vaultId: otherVault });
      expect(reason(() => openReconnection(sealed.text, to, { role: 'initiator' }))).toBe(
        'not-from-peer',
      );
      expect(
        openReconnection(sealed.text, { ...to, vaultId: otherVault }, { role: 'initiator' })
          .reconnection,
      ).toEqual(offer);
    });

    it('refuses a payload from a device the user did not pick, even one of the vault', () => {
      const stranger = generateDeviceIdentity(new Keyring());
      const sealed = seal(offer, {
        ...keys('initiator', 'responder'),
        identity: stranger,
      });
      expect(
        reason(() =>
          openReconnection(sealed.text, keys('responder', 'initiator'), { role: 'initiator' }),
        ),
      ).toBe('not-from-peer');
    });

    it('refuses to seal what opening would reject, so no invalid payload is ever shown', () => {
      const cases: Reconnection[] = [
        { ...offer, setup: 'active' },
        { ...answer, setup: 'actpass' },
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
        { ...offer, candidates: [{ kind: 'host-ipv4', address: new Uint8Array(4), port: 0 }] },
        {
          ...offer,
          candidates: [{ kind: 'relay' as CandidateKind, address: new Uint8Array(4), port: 1 }],
        },
      ];
      for (const p of cases) {
        expect(reason(() => sealReconnection(p, keys('initiator', 'responder')))).toBe('malformed');
      }
    });
  });

  describe('text', () => {
    it('ignores line breaks and tabs, which a text field or a chat may add', () => {
      const { text } = seal(offer, keys('initiator', 'responder'));
      const broken = `${text.slice(0, 10)}\r\n${text.slice(10, 20)}\n\t${text.slice(20)}\n`;
      expect(
        openReconnection(broken, keys('responder', 'initiator'), { role: 'initiator' })
          .reconnection,
      ).toEqual(offer);
    });

    it("refuses a text cut short as malformed, not as another device's", () => {
      const { text } = seal(offer, keys('initiator', 'responder'));
      const cut = text.slice(0, 60);
      expect(
        reason(() => openReconnection(cut, keys('responder', 'initiator'), { role: 'initiator' })),
      ).toBe('malformed');
    });
  });

  it('lets a caller error through, not as a payload refusal: a peer key that is not 32 bytes', () => {
    const { text } = seal(offer, keys('initiator', 'responder'));
    const bad = { ...keys('responder', 'initiator'), peerPublicKey: new Uint8Array(31) };
    expect(() => openReconnection(text, bad, { role: 'initiator' })).toThrow(EncodingError);
    expect(() => openReconnection(text, bad, { role: 'initiator' })).not.toThrow(ReconnectionError);
  });

  it('opens the bytes a delivery carries, and refuses empty bytes as malformed', () => {
    const [c] = v.valid;
    if (!c) throw new Error('no vector');
    const bytes = decodeReconnectionText(c.text);
    expect(toHex(bytes)).toBe(`01${c.message}`);
    expect(encodeReconnectionText(bytes)).toBe(c.text);
    expect(
      openBytes(bytes, keys(c.receiver, c.sender), expectation(c.expect)).reconnection,
    ).toEqual(reconnection(c.payload));
    expect(
      reason(() => openBytes(new Uint8Array(0), keys(c.receiver, c.sender), { role: 'initiator' })),
    ).toBe('malformed');
  });

  it('returns copies, so the caller cannot change the decoded payload through the input', () => {
    const bytes = encodeReconnection(offer);
    const decoded = decodeReconnection(bytes, { role: 'initiator' });
    bytes.fill(0);
    expect(decoded).toEqual(offer);
  });
});
