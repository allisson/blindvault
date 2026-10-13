import { describe, expect, it } from 'vitest';

import { CHECKED_WORDS, drawPositions, wordMatches } from './phrase-check';

describe('Recovery Phrase confirmation (D179)', () => {
  it('draws three distinct positions from 1 to 24, in order', () => {
    for (let i = 0; i < 200; i++) {
      const positions = drawPositions();
      expect(positions).toHaveLength(CHECKED_WORDS);
      expect(new Set(positions).size).toBe(CHECKED_WORDS);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      for (const p of positions) {
        expect(Number.isInteger(p) && p >= 1 && p <= 24).toBe(true);
      }
    }
  });

  it('reaches every position', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) for (const p of drawPositions()) seen.add(p);
    expect(seen.size).toBe(24);
  });

  it('takes the randomness it is given', () => {
    // Always 0: positions 1, then the lowest left each time.
    expect(drawPositions(() => 0)).toEqual([1, 2, 3]);
  });

  it('compares a typed word as the phrase parser reads it', () => {
    expect(wordMatches('abandon', 'abandon')).toBe(true);
    expect(wordMatches('  ABANDON\t', 'abandon')).toBe(true);
    expect(wordMatches('abando', 'abandon')).toBe(false);
    expect(wordMatches('', 'abandon')).toBe(false);
    expect(wordMatches('abandon ability', 'abandon')).toBe(false);
  });
});
