import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ACCENTS, THEME_COLORS } from '../app/appearance';
import source from '../index.css?raw';
import { Spinner } from './components';

// WCAG 2.2 AA for every accent in both themes (overview §13.7, D231): 4.5:1 for text, 3:1 for
// controls and the focus ring. The values are read from index.css itself.

const css = source.replace(/\/\*[\s\S]*?\*\//g, '');

type Vars = Record<string, string>;

/** Each rule's custom properties, keyed by its first selector. */
const rules = new Map<string, Vars>();
for (const [, selectors = '', body = ''] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const key = selectors.split(',')[0]?.replace(/\s+/g, ' ').trim() ?? '';
  const vars: Vars = {};
  for (const [, name = '', value = ''] of body.matchAll(/--bv-([a-z-]+):\s*([^;]+);/g)) {
    vars[name] = value.trim();
  }
  rules.set(key, vars);
}

function rule(selector: string): Vars {
  const vars = rules.get(selector);
  if (!vars) throw new Error(`index.css has no rule ${selector}`);
  return vars;
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT = 4.5;
const CONTROL = 3;

const themes = {
  light: (accent: string) => ({ ...rule(':root'), ...rule(`[data-accent='${accent}']`) }),
  dark: (accent: string) => ({
    ...rule(':root'),
    ...rule("[data-theme='dark']"),
    ...rule(`[data-theme='dark'][data-accent='${accent}']`),
  }),
};

/** [foreground, background, minimum] */
const NEUTRAL: [string, string, number][] = [
  ...['surface', 'raised', 'subtle'].flatMap((bg): [string, string, number][] => [
    ['fg', bg, TEXT],
    ['muted', bg, TEXT],
    ['danger', bg, TEXT],
  ]),
  ...['surface', 'raised'].flatMap((bg): [string, string, number][] => [
    ['control', bg, CONTROL],
    ['warning', bg, TEXT],
    ['info', bg, TEXT],
    ['success', bg, TEXT],
  ]),
  ['danger-ink', 'danger', TEXT],
  ['danger-ink', 'danger-hover', TEXT],
  ['danger-text', 'danger-soft', TEXT],
  ['warning-text', 'warning-soft', TEXT],
  ['info-text', 'info-soft', TEXT],
  ['warning', 'subtle', CONTROL],
  ['success', 'subtle', CONTROL],
];

const ACCENT: [string, string, number][] = [
  ['accent-ink', 'accent', TEXT],
  ['accent-ink', 'accent-hover', TEXT],
  ['fg', 'accent-soft', TEXT],
  ...['surface', 'raised', 'subtle', 'accent-soft'].map((bg): [string, string, number] => [
    'accent-text',
    bg,
    TEXT,
  ]),
  ...['surface', 'raised', 'subtle'].map((bg): [string, string, number] => ['accent', bg, CONTROL]),
];

describe('visual tokens (D231)', () => {
  for (const [theme, vars] of Object.entries(themes)) {
    for (const accent of ACCENTS) {
      it(`meets WCAG 2.2 AA with ${accent} in the ${theme} theme`, () => {
        const v = vars(accent);
        const failures = [...NEUTRAL, ...ACCENT].flatMap(([fg, bg, min]) => {
          const [a, b] = [v[fg], v[bg]];
          if (!a || !b) return [`${fg} on ${bg}: missing`];
          const ratio = contrast(a, b);
          return ratio >= min
            ? []
            : [`${fg} ${a} on ${bg} ${b}: ${ratio.toFixed(2)} < ${String(min)}`];
        });
        expect(failures).toEqual([]);
      });
    }
  }

  it('uses 6-digit hex values, alpha allowed only for the shadow, edge and scrim', () => {
    for (const vars of rules.values()) {
      for (const [name, value] of Object.entries(vars)) {
        const alpha = ['shadow', 'edge', 'scrim'].includes(name);
        expect(value, name).toMatch(alpha ? /^#[0-9a-f]{8}$/ : /^#[0-9a-f]{6}$/);
      }
    }
  });

  it('defines exactly the six accents, blue as the default of :root', () => {
    const defined = [...rules.keys()].flatMap(
      (k) => /^\[data-accent='([a-z]+)'\]$/.exec(k)?.[1] ?? [],
    );
    expect(defined).toEqual([...ACCENTS]);
    const root = rule(':root');
    for (const [name, value] of Object.entries(rule("[data-accent='blue']"))) {
      expect(root[name], name).toBe(value);
    }
  });

  it('gives theme-color the surface of each theme', () => {
    expect(THEME_COLORS.light).toBe(rule(':root').surface);
    expect(THEME_COLORS.dark).toBe(rule("[data-theme='dark']").surface);
  });
});

describe('components name no palette color (D231)', () => {
  const PALETTE =
    /\b(?:zinc|slate|gray|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b|\bdark:|\b(?:bg|text|border|ring|outline)-(?:white|black)\b/;

  const sources = import.meta.glob<string>('../**/*.tsx', {
    query: '?raw',
    import: 'default',
    eager: true,
  });

  it('uses only semantic tokens', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(20);
    const found = Object.entries(sources).flatMap(([file, text]) =>
      text
        .split('\n')
        .flatMap((line, i) => (PALETTE.test(line) ? [`${file}:${String(i + 1)}`] : [])),
    );
    expect(found).toEqual([]);
  });
});

describe('motion runs only for users who have not asked for reduced motion (D231)', () => {
  // A class that animates or transitions, with its variants: each must start with `motion-safe:`.
  const MOTION =
    /[\w:[\]-]*(?<![\w-])(?:animate|transition|duration|ease|delay|scale|translate|rotate)-[\w.[\]-]+|[\w:-]*(?<![\w-])transition(?![\w-])/g;

  const sources = import.meta.glob<string>('../**/*.tsx', {
    query: '?raw',
    import: 'default',
    eager: true,
  });

  it('declares every animation and transition behind motion-safe', () => {
    const found = Object.entries(sources).flatMap(([file, text]) =>
      text
        .split('\n')
        .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
        .flatMap((line) => [...line.matchAll(MOTION)].map(([token]) => token))
        .filter((token) => !token.startsWith('motion-safe:'))
        .map((token) => `${file}: ${token}`),
    );
    expect(found).toEqual([]);
  });

  // No e2e holds a button busy long enough to look at it, so its spinner is checked here (D236).
  it('hides the busy spinner under reduced motion, leaving the label that names the work', () => {
    expect(renderToStaticMarkup(createElement(Spinner))).toContain('motion-reduce:hidden');
  });
});
