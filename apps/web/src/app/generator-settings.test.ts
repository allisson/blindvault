import { describe, expect, it } from 'vitest';

import { DEFAULT_GENERATOR, readGeneratorSettings } from './generator-settings';

describe('generator settings (D128)', () => {
  it('reads stored settings', () => {
    const settings = { mode: 'words', length: 32, sets: ['digits', 'lowercase'], words: 8 };
    expect(readGeneratorSettings(JSON.stringify(settings))).toEqual({
      ...settings,
      sets: ['lowercase', 'digits'],
    });
  });

  it.each([
    ['nothing', null],
    ['malformed JSON', '{'],
    ['a non-object', '7'],
  ])('falls back to the defaults for %s', (_name, raw) => {
    expect(readGeneratorSettings(raw)).toEqual(DEFAULT_GENERATOR);
  });

  it('replaces each value outside the limits by its default, never clamping it', () => {
    const raw = JSON.stringify({ mode: 'x', length: 11, sets: ['emoji'], words: 25 });
    expect(readGeneratorSettings(raw)).toEqual(DEFAULT_GENERATOR);
    expect(readGeneratorSettings(JSON.stringify({ length: 12.5, words: 3 }))).toEqual(
      DEFAULT_GENERATOR,
    );
  });

  it('holds no generated value', () => {
    expect(Object.keys(DEFAULT_GENERATOR).sort()).toEqual(['length', 'mode', 'sets', 'words']);
  });
});
