import { type Field, FIELD_TYPES, TEMPLATES } from '@blindvault/vault';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { LanguageProvider } from '../i18n/context';
import { ItemRow } from './ItemRow';

// CRYPTO-INV-024: an item holding every field type, each secret one also under every role a
// subtitle reads, renders a row with no `secret`, TOTP or seed-phrase value in it.

const SEED = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXPQUARTZ';

function secretField(type: 'secret' | 'totp' | 'seed-phrase', role?: string): Field {
  const value =
    type === 'totp'
      ? { secret: TOTP_SECRET, algorithm: 'SHA1' as const, digits: 6, period: 30 }
      : type === 'seed-phrase'
        ? SEED
        : `velvet-harbor-${role ?? 'none'}`;
  return role === undefined ? { type, value } : { type, value, role };
}

describe('the list row shows no secret (CRYPTO-INV-024)', () => {
  for (const template of TEMPLATES) {
    it(`holds no secret value for a ${template.id}`, () => {
      const roles = [undefined, ...TEMPLATES.flatMap((t) => t.roles.map((r) => r.role))];
      const fields: Field[] = [
        ...FIELD_TYPES.filter((t) => t !== 'secret' && t !== 'totp' && t !== 'seed-phrase').map(
          (type): Field => ({ type, value: `shown-${type}`, label: type }),
        ),
        ...(['secret', 'totp', 'seed-phrase'] as const).flatMap((type) =>
          roles.map((role) => secretField(type, role)),
        ),
      ];
      const html = renderToStaticMarkup(
        createElement(
          LanguageProvider,
          null,
          createElement(ItemRow, {
            name: 'Harbor',
            item: {
              templateId: template.id,
              templateVersion: 1,
              title: 'Harbor',
              fields,
              tags: [],
            },
            selected: false,
            onSelect: () => undefined,
            onCopy: () => undefined,
          }),
        ),
      );
      expect(html).toContain('Harbor');
      for (const leak of ['velvet-harbor', TOTP_SECRET, 'abandon'])
        expect(html).not.toContain(leak);
    });
  }
});
