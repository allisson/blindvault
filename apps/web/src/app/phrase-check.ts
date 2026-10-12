// The Recovery Phrase confirmation at creation (§5.4, D179): the words at three positions drawn at
// random. Which positions are asked is not secret; the words typed are compared in memory only.

import { PHRASE_WORDS } from '@blindvault/crypto';

export const CHECKED_WORDS = 3;

/** A uniform integer in `[0, n)` from the platform's CSPRNG, by rejection. */
function uniform(n: number): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const out = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(out);
    const x = out[0] ?? 0;
    if (x < limit) return x % n;
  }
}

/** Three distinct positions, 1 to 24, in ascending order. */
export function drawPositions(random: (n: number) => number = uniform): number[] {
  const left = Array.from({ length: PHRASE_WORDS }, (_, i) => i + 1);
  const out: number[] = [];
  for (let i = 0; i < CHECKED_WORDS; i++) out.push(...left.splice(random(left.length), 1));
  return out.sort((a, b) => a - b);
}

/** Whether `typed` is `word`, read as the phrase parser reads input: NFKD, lowercase, trimmed. */
export function wordMatches(typed: string, word: string): boolean {
  return typed.normalize('NFKD').toLowerCase().trim() === word;
}
