import { beforeAll, describe, expect, it } from 'vitest';

import { EncodingError } from './errors';
import { initCrypto } from './sodium';
import { fromHex, toHex, vectors } from './test-helpers';
import { pairingPrologue } from './transcripts';

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
