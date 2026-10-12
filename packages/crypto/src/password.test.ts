import { beforeAll, describe, expect, it } from 'vitest';

import { KdfParamsRejectedError, PasswordRejectedError } from './errors';
import {
  ACCEPTED_KDF_RANGE,
  MEMLIMIT,
  SALT_LENGTH,
  argon2id,
  calibrate,
  checkKdfParams,
  generateSalt,
  normalizePassword,
} from './password';
import { initCrypto } from './sodium';
import { fromHex, toHex, vectors } from './test-helpers';

beforeAll(initCrypto);

const a2 = vectors.argon2id;

describe('password normalization (crypto-spec.md §6)', () => {
  it('normalizes the vector password', () => {
    expect(toHex(normalizePassword(a2.passwordAsTyped))).toBe(a2.passwordNormalizedUtf8);
  });

  it.each(a2.normalization)('normalizes $input', ({ input, output }) => {
    expect(toHex(normalizePassword(input))).toBe(output);
  });

  it.each(a2.rejectedPasswords)('rejects %j', (input) => {
    expect(() => normalizePassword(input)).toThrow(PasswordRejectedError);
  });

  it('names the reason without echoing the password', () => {
    const error = (() => {
      try {
        normalizePassword('se\u0007cret');
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(PasswordRejectedError);
    expect(error).toMatchObject({ reason: 'control-character' });
    expect(String(error)).not.toContain('cret');
    expect(() => normalizePassword('\u2003')).toThrow(expect.objectContaining({ reason: 'empty' }));
  });

  it('keeps leading and trailing spaces of a non-empty password', () => {
    expect(toHex(normalizePassword(' a '))).toBe('206120');
  });
});

describe('Argon2id (crypto-spec.md §6, D9)', () => {
  it('reproduces the Device KEK at 64 MiB, opslimit 2', () => {
    const key = argon2id(fromHex(a2.passwordNormalizedUtf8), fromHex(a2.salt), {
      opslimit: a2.opslimit,
      memlimit: a2.memlimit,
    });
    expect(toHex(key)).toBe(a2.deviceKek);
    expect(a2.memlimit).toBe(MEMLIMIT);
  });

  it('publishes the accepted range of the vectors', () => {
    expect(ACCEPTED_KDF_RANGE).toEqual(a2.acceptedRange);
  });

  it.each([
    ...a2.rejectedParameters,
    { memlimit: MEMLIMIT, opslimit: 2.5 },
    { memlimit: Number.NaN, opslimit: 2 },
  ])('rejects $memlimit / $opslimit before deriving', (params) => {
    expect(() => {
      checkKdfParams(params);
    }).toThrow(KdfParamsRejectedError);
    expect(() => argon2id(new Uint8Array(1), generateSalt(), params)).toThrow(
      KdfParamsRejectedError,
    );
  });

  it('rejects a salt that is not 16 bytes', () => {
    expect(generateSalt()).toHaveLength(SALT_LENGTH);
    expect(() =>
      argon2id(new Uint8Array(1), new Uint8Array(15), { opslimit: 2, memlimit: MEMLIMIT }),
    ).toThrow(KdfParamsRejectedError);
  });
});

/** A fake derivation whose duration at each opslimit is `cost(opslimit)` ms of a fake clock. */
function fakeKdf(cost: (opslimit: number) => number) {
  let clock = 0;
  const calls: number[] = [];
  const outputs: Uint8Array[] = [];
  return {
    calls,
    outputs,
    now: () => clock,
    derive: (opslimit: number) => {
      calls.push(opslimit);
      clock += cost(opslimit);
      const out = new Uint8Array(32).fill(opslimit);
      outputs.push(out);
      return out;
    },
  };
}

describe('calibration (D166)', () => {
  it.each([
    ['a slow device stays at 2', () => 1500, [2], 2],
    ['exactly 1000 ms at 2 stays at 2', () => 1000, [2], 2],
    ['a linear device lands on the extrapolation', (o: number) => 125 * o, [2, 8], 8],
    [
      'an underestimate steps up until 1000 ms',
      (o: number) => (o === 2 ? 200 : 90 * o),
      [2, 10, 11, 12],
      12,
    ],
    ['a fast device is capped at 64', (o: number) => o, [2, 64], 64],
    ['a zero-time derivation is capped at 64', () => 0, [2, 64], 64],
    [
      'stepping stops at 64',
      (o: number) => (o === 2 ? 40 : 10 * o),
      [2, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64],
      64,
    ],
  ])('%s', (_name, cost, expectedCalls, expected) => {
    const kdf = fakeKdf(cost);
    const { key, opslimit } = calibrate(kdf.derive, kdf.now);
    expect(opslimit).toBe(expected);
    expect(kdf.calls).toEqual(expectedCalls);
    expect(key).toBe(kdf.outputs.at(-1));
    expect(key.every((b) => b === expected)).toBe(true);
    for (const earlier of kdf.outputs.slice(0, -1))
      expect(earlier.every((b) => b === 0)).toBe(true);
  });
});
