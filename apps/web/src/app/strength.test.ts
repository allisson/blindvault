import { generatePassphrase, initCrypto } from '@blindvault/crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import { EXPORT_ENTROPY_BITS, EXPORT_GUESSES, estimator, exportStrength } from './strength';

beforeAll(initCrypto);

describe('local password strength (D71)', () => {
  it('requires zxcvbn score 4', async () => {
    const estimate = await estimator('en');
    expect(estimate('password1').acceptable).toBe(false);
    expect(estimate('correct horse battery staple orbit').acceptable).toBe(true);
  });
});

describe('export password strength (D134, D155)', () => {
  it('requires an estimated 10^14 guesses, above the local threshold', async () => {
    const estimate = await estimator('en');
    // Score 4 starts at 10^10 guesses: a password can pass locally and still fail for export.
    const local = 'Tr0ub4dour&3x';
    const strength = estimate(local);
    expect(strength.guesses).toBeGreaterThanOrEqual(1e10);
    expect(strength.guesses).toBeLessThan(EXPORT_GUESSES);
    expect(strength.acceptable).toBe(true);
    expect((await exportStrength('en', local)).acceptable).toBe(false);
    const long = 'correct horse battery staple orbit lantern quiet';
    expect(estimate(long).guesses).toBeGreaterThanOrEqual(EXPORT_GUESSES);
    expect((await exportStrength('en', long)).acceptable).toBe(true);
  });

  it('judges an unchanged generated passphrase by its exact entropy', async () => {
    expect(EXPORT_ENTROPY_BITS).toBeCloseTo(Math.log2(1e14));
    const six = generatePassphrase(6);
    const result = await exportStrength('en', six.value, six);
    expect(result).toMatchObject({ acceptable: true, generated: true });
    const four = generatePassphrase(4);
    expect(four.entropyBits).toBeLessThan(EXPORT_ENTROPY_BITS);
    expect(await exportStrength('en', four.value, four)).toMatchObject({
      acceptable: false,
      generated: true,
    });
  });

  it('falls back to zxcvbn once the generated passphrase is edited', async () => {
    const six = generatePassphrase(6);
    const edited = await exportStrength('en', 'abc', six);
    expect(edited).toMatchObject({ acceptable: false, generated: false });
  });
});
