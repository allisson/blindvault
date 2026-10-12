import { TEMPLATES } from '@blindvault/vault';
import { describe, expect, it } from 'vitest';

import { LANGUAGES, MESSAGES, pickLanguage, roleName } from './messages';

/** Every leaf as `[path, value]`; paths join with `/`, since role keys contain dots. */
function leaves(value: unknown, prefix = ''): [string, unknown][] {
  if (typeof value !== 'object' || value === null) return [[prefix, value]];
  return Object.entries(value).flatMap(([k, v]) => leaves(v, `${prefix}/${k}`));
}

describe('UI copy (D165)', () => {
  it('has the same keys, all non-empty, in every language', () => {
    const en = leaves(MESSAGES.en)
      .map(([path]) => path)
      .sort();
    for (const language of LANGUAGES) {
      const all = leaves(MESSAGES[language]);
      expect(all.map(([path]) => path).sort()).toEqual(en);
      for (const [, value] of all) {
        expect(typeof value === 'string' && value.trim().length > 0).toBe(true);
      }
    }
  });

  it('names every template and every template role, in every language', () => {
    for (const language of LANGUAGES) {
      const m = MESSAGES[language];
      for (const t of TEMPLATES) {
        expect(Object.hasOwn(m.templates, t.id)).toBe(true);
        for (const r of t.roles) expect(roleName(m, t.id, r.role)).toBeTruthy();
      }
      expect(roleName(m, 'login', 'unknown')).toBeUndefined();
      expect(roleName(m, 'login', 'constructor')).toBeUndefined();
    }
    const known = TEMPLATES.flatMap((t) => t.roles.map((r) => `${t.id}.${r.role}`)).sort();
    expect(Object.keys(MESSAGES.en.roles).sort()).toEqual(known);
  });

  it('picks the first supported language of the browser, en otherwise', () => {
    expect(pickLanguage(['pt-BR', 'en'])).toBe('pt-BR');
    expect(pickLanguage(['pt-PT'])).toBe('pt-BR');
    expect(pickLanguage(['fr-FR', 'en-GB', 'pt-BR'])).toBe('en');
    expect(pickLanguage(['fr-FR'])).toBe('en');
    expect(pickLanguage([])).toBe('en');
  });
});
