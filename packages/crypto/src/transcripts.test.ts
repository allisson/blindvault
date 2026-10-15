import { beforeAll, describe, expect, it } from 'vitest';

import { EncodingError } from './errors';
import { Keyring, adoptKey } from './keys';
import { initCrypto } from './sodium';
import { fromHex, toHex, vectors } from './test-helpers';
import {
  PAIRING_NONCE_LENGTH,
  checkPairingCommitment,
  checkReadmissionMac,
  pairingCommitment,
  pairingNonce,
  pairingPrologue,
  pairingSas,
  readmissionMac,
} from './transcripts';

beforeAll(initCrypto);

const t = vectors.transcripts;
const args = () =>
  [
    fromHex(t.prologueXX.payloadInitiator),
    fromHex(t.prologueXX.payloadResponder),
    fromHex(t.dtlsFingerprintInitiator),
    fromHex(t.dtlsFingerprintResponder),
  ] as const;

describe('prologue_XX (crypto-spec.md §13)', () => {
  it('reproduces the vector', () => {
    expect(toHex(pairingPrologue(...args()))).toBe(t.prologueXX.prologue);
  });

  it.each([0, 1, 2, 3])('changes with input %i, and with the role order', (index) => {
    const changed = [...args()];
    const value = changed[index]?.slice() ?? new Uint8Array();
    value[0] = (value[0] ?? 0) ^ 1;
    changed[index] = value;
    expect(toHex(pairingPrologue(...(changed as unknown as ReturnType<typeof args>)))).not.toBe(
      t.prologueXX.prologue,
    );
    const [pi, pr, fi, fr] = args();
    expect(toHex(pairingPrologue(pr, pi, fr, fi))).not.toBe(t.prologueXX.prologue);
  });

  it('refuses a fingerprint that is not 32 bytes', () => {
    const [pi, pr, fi] = args();
    expect(() => pairingPrologue(pi, pr, fi, new Uint8Array(31))).toThrow(EncodingError);
    expect(() => pairingPrologue(pi, pr, new Uint8Array(33), fi)).toThrow(EncodingError);
  });
});

describe('pairing commitment (pairing-protocol.md §6.1)', () => {
  const c = t.pairingCommitment;

  it('reproduces the vector', () => {
    expect(toHex(pairingCommitment(fromHex(c.nonce)))).toBe(c.commitment);
  });

  it('draws a new 32-byte nonce with its commitment each time', () => {
    const first = pairingNonce();
    const second = pairingNonce();
    expect(first.nonce).toHaveLength(PAIRING_NONCE_LENGTH);
    expect(toHex(first.commitment)).toBe(toHex(pairingCommitment(first.nonce)));
    expect(toHex(first.nonce)).not.toBe(toHex(second.nonce));
  });

  it('accepts the nonce that opens the commitment, and no other', () => {
    expect(checkPairingCommitment(fromHex(c.commitment), fromHex(c.nonce))).toBe(true);
    const nonce = fromHex(c.nonce);
    nonce[31] = (nonce[31] ?? 0) ^ 1;
    expect(checkPairingCommitment(fromHex(c.commitment), nonce)).toBe(false);
    const commitment = fromHex(c.commitment);
    commitment[0] = (commitment[0] ?? 0) ^ 1;
    expect(checkPairingCommitment(commitment, fromHex(c.nonce))).toBe(false);
  });

  it('refuses inputs of the wrong length', () => {
    expect(() => pairingCommitment(new Uint8Array(31))).toThrow(EncodingError);
    expect(() => checkPairingCommitment(new Uint8Array(31), fromHex(c.nonce))).toThrow(
      EncodingError,
    );
    expect(() => checkPairingCommitment(fromHex(c.commitment), new Uint8Array(33))).toThrow(
      EncodingError,
    );
  });
});

describe('SAS (pairing-protocol.md §6.2)', () => {
  const sasArgs = (v: (typeof t.sas)[number]) =>
    [fromHex(v.handshakeHash), fromHex(v.nonceInitiator), fromHex(v.nonceResponder)] as const;

  it.each(t.sas.map((v) => [v.sas, v] as const))('reproduces the vector %s', (_sas, v) => {
    expect(pairingSas(...sasArgs(v))).toBe(v.sas);
  });

  it('keeps leading zeros, as six digits', () => {
    const low = t.sas.find((v) => v.sas.startsWith('000'));
    expect(low).toBeDefined();
    if (low) expect(pairingSas(...sasArgs(low))).toMatch(/^000\d{3}$/);
  });

  it.each([0, 1, 2])('changes with input %i, and with the order of the nonces', (index) => {
    const v = t.sas[0];
    if (!v) throw new Error('no vector');
    const changed = [...sasArgs(v)];
    const value = changed[index]?.slice() ?? new Uint8Array();
    value[0] = (value[0] ?? 0) ^ 1;
    changed[index] = value;
    expect(pairingSas(...(changed as unknown as ReturnType<typeof sasArgs>))).not.toBe(v.sas);
    const [hh, ni, nr] = sasArgs(v);
    expect(pairingSas(hh, nr, ni)).not.toBe(v.sas);
  });

  it('refuses inputs of the wrong length', () => {
    const v = t.sas[0];
    if (!v) throw new Error('no vector');
    const [hh, ni, nr] = sasArgs(v);
    expect(() => pairingSas(hh.subarray(0, 32), ni, nr)).toThrow(EncodingError);
    expect(() => pairingSas(hh, ni.subarray(1), nr)).toThrow(EncodingError);
    expect(() => pairingSas(hh, ni, new Uint8Array(33))).toThrow(EncodingError);
  });
});

describe('re-admission key confirmation (crypto-spec.md §13, pairing-protocol.md §9, D29)', () => {
  const key = (keyring: Keyring, hex: string) => adoptKey(keyring, fromHex(hex));

  it.each(t.readmissionMac.map((v) => [v.role, v] as const))(
    'reproduces the %s vector',
    (_role, v) => {
      const keyring = new Keyring();
      const k = key(keyring, v.readmissionKey);
      const mac = readmissionMac(k, v.role as 'initiator' | 'responder', fromHex(v.handshakeHash));
      expect(toHex(mac)).toBe(v.mac);
      expect(
        checkReadmissionMac(k, v.role as 'initiator' | 'responder', fromHex(v.handshakeHash), mac),
      ).toBe(true);
      keyring.wipeAll();
    },
  );

  it('binds the role, the handshake hash and the key: any other one fails the check', () => {
    const [v] = t.readmissionMac;
    if (!v) throw new Error('no vector');
    const keyring = new Keyring();
    const k = key(keyring, v.readmissionKey);
    const h = fromHex(v.handshakeHash);
    const mac = readmissionMac(k, 'initiator', h);
    // A peer that echoes this device's own MAC back is refused: the roles differ.
    expect(checkReadmissionMac(k, 'responder', h, mac)).toBe(false);
    const otherHash = h.slice();
    otherHash[0] = (otherHash[0] ?? 0) ^ 1;
    expect(checkReadmissionMac(k, 'initiator', otherHash, mac)).toBe(false);
    const otherKey = fromHex(v.readmissionKey);
    otherKey[0] = (otherKey[0] ?? 0) ^ 1;
    expect(checkReadmissionMac(adoptKey(keyring, otherKey), 'initiator', h, mac)).toBe(false);
    const tampered = mac.slice();
    tampered[31] = (tampered[31] ?? 0) ^ 1;
    expect(checkReadmissionMac(k, 'initiator', h, tampered)).toBe(false);
    keyring.wipeAll();
  });

  it('refuses a handshake hash or a MAC of the wrong length', () => {
    const [v] = t.readmissionMac;
    if (!v) throw new Error('no vector');
    const keyring = new Keyring();
    const k = key(keyring, v.readmissionKey);
    expect(() => readmissionMac(k, 'initiator', new Uint8Array(32))).toThrow(EncodingError);
    expect(() =>
      checkReadmissionMac(k, 'initiator', fromHex(v.handshakeHash), new Uint8Array(31)),
    ).toThrow(EncodingError);
    keyring.wipeAll();
  });
});
