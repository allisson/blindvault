// The password generator's settings: non-sensitive UI preferences, the one kind `localStorage` may
// hold (overview §7, §13.6). A generated value is never stored here or anywhere else (D128).

import { type CharacterSetName, DEFAULT_SETS, GENERATOR_LIMITS } from '@blindvault/crypto';

export interface GeneratorSettings {
  readonly mode: 'characters' | 'words';
  readonly length: number;
  readonly sets: readonly CharacterSetName[];
  readonly words: number;
}

export const DEFAULT_GENERATOR: GeneratorSettings = {
  mode: 'characters',
  length: GENERATOR_LIMITS.characters.default,
  sets: DEFAULT_SETS,
  words: GENERATOR_LIMITS.words.default,
};

const STORAGE_KEY = 'blindvault.generator';
const SETS: readonly CharacterSetName[] = ['lowercase', 'uppercase', 'digits', 'symbols'];

function within(value: unknown, limits: { min: number; max: number }, fallback: number): number {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= limits.min &&
    value <= limits.max
    ? value
    : fallback;
}

/** Stored settings, each invalid or missing one replaced by its default. */
export function readGeneratorSettings(raw: string | null): GeneratorSettings {
  let parsed: unknown;
  try {
    parsed = raw === null ? null : JSON.parse(raw);
  } catch {
    return DEFAULT_GENERATOR;
  }
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_GENERATOR;
  const p = parsed as Record<string, unknown>;
  const sets = Array.isArray(p.sets) ? SETS.filter((s) => (p.sets as unknown[]).includes(s)) : [];
  return {
    mode: p.mode === 'words' ? 'words' : 'characters',
    length: within(p.length, GENERATOR_LIMITS.characters, DEFAULT_GENERATOR.length),
    sets: sets.length > 0 ? sets : DEFAULT_GENERATOR.sets,
    words: within(p.words, GENERATOR_LIMITS.words, DEFAULT_GENERATOR.words),
  };
}

export function loadGeneratorSettings(): GeneratorSettings {
  try {
    return readGeneratorSettings(localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_GENERATOR;
  }
}

export function saveGeneratorSettings(settings: GeneratorSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // storage unavailable: the settings last for this app window
  }
}
