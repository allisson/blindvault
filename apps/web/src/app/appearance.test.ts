import { describe, expect, it } from 'vitest';

import {
  ACCENTS,
  type Appearance,
  DEFAULT_APPEARANCE,
  THEMES,
  applyAppearance,
  readAppearance,
  resolveTheme,
} from './appearance';

describe('appearance (D231)', () => {
  it('defaults to the system theme and blue', () => {
    expect(DEFAULT_APPEARANCE).toEqual({ theme: 'system', accent: 'blue' });
    expect(readAppearance(null)).toEqual(DEFAULT_APPEARANCE);
  });

  it('reads every theme and accent it writes', () => {
    for (const theme of THEMES) {
      for (const accent of ACCENTS) {
        const a: Appearance = { theme, accent };
        expect(readAppearance(JSON.stringify(a))).toEqual(a);
      }
    }
  });

  it('replaces each unknown or missing value by its default', () => {
    expect(readAppearance('not json')).toEqual(DEFAULT_APPEARANCE);
    expect(readAppearance('"dark"')).toEqual(DEFAULT_APPEARANCE);
    expect(readAppearance('{"theme":"dark","accent":"orange"}')).toEqual({
      theme: 'dark',
      accent: 'blue',
    });
    expect(readAppearance('{"theme":"sepia","accent":"rose"}')).toEqual({
      theme: 'system',
      accent: 'rose',
    });
    expect(readAppearance('{"accent":"constructor"}')).toEqual(DEFAULT_APPEARANCE);
  });

  it('follows the system only while System is chosen', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('sets the theme, the accent and theme-color', () => {
    const attrs: Record<string, string> = {};
    const meta: Record<string, string> = {};
    applyAppearance(
      { theme: 'system', accent: 'teal' },
      {
        root: {
          setAttribute: (n, v) => {
            attrs[n] = v;
          },
        },
        themeColor: {
          setAttribute: (n, v) => {
            meta[n] = v;
          },
        },
        systemDark: { matches: true },
      },
    );
    expect(attrs).toEqual({ 'data-theme': 'dark', 'data-accent': 'teal' });
    expect(meta).toEqual({ content: '#09090b' });
  });
});
