// Password generator (§13.6, D128, D138, crypto-spec.md §16). Every choice comes from libsodium's
// `randombytes_uniform`, which has no modulo bias; nothing is kept or persisted.

import { wordlist } from '@scure/bip39/wordlists/english.js';

import { GeneratorRejectedError } from './errors';
import { lib } from './sodium';

export const CharacterSet = {
  lowercase: 'abcdefghijklmnopqrstuvwxyz',
  uppercase: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  symbols: '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~',
} as const;

export type CharacterSetName = keyof typeof CharacterSet;

export const GENERATOR_LIMITS = {
  characters: { min: 12, default: 20, max: 128 },
  words: { min: 4, default: 6, max: 24 },
} as const;

export const DEFAULT_SETS: readonly CharacterSetName[] = [
  'lowercase',
  'uppercase',
  'digits',
  'symbols',
];
export const WORD_SEPARATOR = '-';

export interface Generated {
  /** A JavaScript string cannot be wiped: keep it only in the field being edited. */
  readonly value: string;
  /** Exact entropy of the settings, in bits. */
  readonly entropyBits: number;
}

function check(count: number, limits: { min: number; max: number }): void {
  if (!Number.isSafeInteger(count) || count < limits.min || count > limits.max) {
    throw new GeneratorRejectedError();
  }
}

/** The union of the selected sets, in a fixed order; the sets are disjoint. */
function alphabet(sets: readonly CharacterSetName[]): string {
  const chosen = new Set(sets);
  if (chosen.size === 0 || ![...chosen].every((s) => Object.hasOwn(CharacterSet, s))) {
    throw new GeneratorRejectedError();
  }
  return (Object.keys(CharacterSet) as CharacterSetName[])
    .filter((s) => chosen.has(s))
    .map((s) => CharacterSet[s])
    .join('');
}

function draw(n: number): number {
  return lib().randombytes_uniform(n);
}

/** Entropy in bits of `length` characters from `sets`, without generating anything. */
export function passwordEntropyBits(length: number, sets: readonly CharacterSetName[]): number {
  check(length, GENERATOR_LIMITS.characters);
  return length * Math.log2(alphabet(sets).length);
}

/** Entropy in bits of a passphrase of `words` words: 11 bits each (D155). */
export function passphraseEntropyBits(words: number): number {
  check(words, GENERATOR_LIMITS.words);
  return words * Math.log2(wordlist.length);
}

/** `length` characters, each drawn uniformly from the union of `sets` (D138). */
export function generatePassword(
  length: number = GENERATOR_LIMITS.characters.default,
  sets: readonly CharacterSetName[] = DEFAULT_SETS,
): Generated {
  const entropyBits = passwordEntropyBits(length, sets);
  const chars = alphabet(sets);
  let value = '';
  for (let i = 0; i < length; i++) value += chars.charAt(draw(chars.length));
  return { value, entropyBits };
}

/** `words` words of the BIP39 English list, joined by `WORD_SEPARATOR`. */
export function generatePassphrase(words: number = GENERATOR_LIMITS.words.default): Generated {
  const entropyBits = passphraseEntropyBits(words);
  const picked: string[] = [];
  for (let i = 0; i < words; i++) picked.push(wordlist[draw(wordlist.length)] ?? '');
  return { value: picked.join(WORD_SEPARATOR), entropyBits };
}
