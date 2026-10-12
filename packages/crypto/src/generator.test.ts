import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { wordlist } from '@scure/bip39/wordlists/english.js';

import { GeneratorRejectedError } from './errors';
import {
  CharacterSet,
  DEFAULT_SETS,
  GENERATOR_LIMITS,
  WORD_SEPARATOR,
  generatePassphrase,
  generatePassword,
  passphraseEntropyBits,
  passwordEntropyBits,
} from './generator';
import { initCrypto, lib } from './sodium';

beforeAll(initCrypto);
afterEach(() => {
  vi.restoreAllMocks();
});

const ALL = Object.values(CharacterSet).join('');

describe('password generator (D128, D138)', () => {
  it('defaults to 20 characters from the four sets', () => {
    const { value, entropyBits } = generatePassword();
    expect(value).toHaveLength(20);
    expect(DEFAULT_SETS).toEqual(['lowercase', 'uppercase', 'digits', 'symbols']);
    expect(ALL).toHaveLength(94);
    expect(new Set(ALL).size).toBe(94);
    expect(entropyBits).toBeCloseTo(20 * Math.log2(94), 10);
    expect(value).toMatch(/^[!-~]{20}$/);
  });

  it('draws every character with one randombytes_uniform call bounded by the union size', () => {
    const uniform = vi.spyOn(lib(), 'randombytes_uniform');
    generatePassword(16, ['digits', 'lowercase']);
    expect(uniform).toHaveBeenCalledTimes(16);
    for (const [bound] of uniform.mock.calls) expect(bound).toBe(36);
  });

  it('maps each index to exactly one character of the union, in a fixed order', () => {
    let next = 0;
    vi.spyOn(lib(), 'randombytes_uniform').mockImplementation(() => next++);
    const { value } = generatePassword(36, ['lowercase', 'digits']);
    expect(value).toBe(CharacterSet.lowercase + CharacterSet.digits);
    next = 0;
    // The order of the selection does not change the alphabet.
    expect(generatePassword(36, ['digits', 'lowercase', 'digits']).value).toBe(value);
  });

  it('gives no guarantee of one character per set (D138)', () => {
    vi.spyOn(lib(), 'randombytes_uniform').mockReturnValue(0);
    expect(generatePassword(12).value).toBe('a'.repeat(12));
  });

  it('is uniform over its alphabet (chi-square sanity check)', () => {
    const counts = new Map<string, number>();
    const draws = 200;
    for (let i = 0; i < draws; i++) {
      for (const c of generatePassword(128).value) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    const expected = (draws * 128) / 94;
    let chi2 = 0;
    for (const c of ALL) chi2 += ((counts.get(c) ?? 0) - expected) ** 2 / expected;
    // 93 degrees of freedom: the 99.99th percentile is about 155.
    expect(chi2).toBeLessThan(155);
    expect(counts.size).toBe(94);
  });

  it.each([
    ['11 characters', 11, DEFAULT_SETS],
    ['129 characters', 129, DEFAULT_SETS],
    ['a fractional length', 12.5, DEFAULT_SETS],
    ['no set', 20, []],
    ['an unknown set', 20, ['emoji']],
  ])('offers no value for %s', (_name, length, sets) => {
    const uniform = vi.spyOn(lib(), 'randombytes_uniform');
    expect(() => generatePassword(length, sets as never)).toThrow(GeneratorRejectedError);
    expect(() => passwordEntropyBits(length, sets as never)).toThrow(GeneratorRejectedError);
    expect(uniform).not.toHaveBeenCalled();
  });

  it('accepts the limits', () => {
    expect(generatePassword(GENERATOR_LIMITS.characters.min, ['digits']).value).toMatch(
      /^[0-9]{12}$/,
    );
    expect(generatePassword(GENERATOR_LIMITS.characters.max).value).toHaveLength(128);
  });
});

describe('passphrase generator (D128, D155)', () => {
  it('defaults to 6 BIP39 English words, about 66 bits', () => {
    const { value, entropyBits } = generatePassphrase();
    const words = value.split(WORD_SEPARATOR);
    expect(words).toHaveLength(6);
    expect(words.every((w) => wordlist.includes(w))).toBe(true);
    expect(entropyBits).toBe(66);
    expect(passphraseEntropyBits(4)).toBe(44);
  });

  it('draws every word with randombytes_uniform(2048)', () => {
    const uniform = vi.spyOn(lib(), 'randombytes_uniform');
    generatePassphrase(8);
    expect(uniform).toHaveBeenCalledTimes(8);
    for (const [bound] of uniform.mock.calls) expect(bound).toBe(2048);
  });

  it('maps each index to its word of the list', () => {
    vi.spyOn(lib(), 'randombytes_uniform')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(2047)
      .mockReturnValue(1);
    expect(generatePassphrase(4).value).toBe('abandon-zoo-ability-ability');
  });

  it.each([3, 25, 4.5])('offers no value for %s words', (words) => {
    expect(() => generatePassphrase(words)).toThrow(GeneratorRejectedError);
  });
});
