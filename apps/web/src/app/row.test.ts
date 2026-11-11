import { type Field, type Item } from '@blindvault/vault';
import { describe, expect, it } from 'vitest';

import { avatar, letter, rowPassword, subtitle } from './row';

const item = (templateId: string, fields: Field[]): Item => ({
  templateId,
  templateVersion: 1,
  title: 'x',
  fields,
  tags: [],
});

describe('list row (D246)', () => {
  it('shows a Login as its username and host', () => {
    const login = item('login', [
      { type: 'text', role: 'username', value: 'ana' },
      { type: 'secret', role: 'password', value: 'hunter2-velvet' },
      { type: 'url', role: 'url', value: 'https://bank.example:8443/login?x=1' },
    ]);
    expect(subtitle(login)).toBe('ana · bank.example:8443');
    expect(rowPassword(login)).toBe('hunter2-velvet');
  });

  it('skips empty roles, keeps a URL that does not parse, and shows nothing for a note', () => {
    expect(
      subtitle(
        item('login', [
          { type: 'text', role: 'username', value: ' ' },
          { type: 'url', role: 'url', value: 'bank.example' },
        ]),
      ),
    ).toBe('bank.example');
    expect(subtitle(item('secure-note', []))).toBe('');
    expect(subtitle(item('constructor', []))).toBe('');
    expect(rowPassword(item('login', [{ type: 'secret', role: 'password', value: '' }]))).toBe(
      undefined,
    );
  });

  // CRYPTO-INV-024: a field of a never-read type is never shown, whatever role it claims.
  it('never shows a secret, TOTP or seed-phrase value', () => {
    const fields: Field[] = [
      { type: 'secret', role: 'cardholder', value: 'SECRET-cardholder' },
      { type: 'seed-phrase', role: 'walletName', value: 'SECRET-seed' },
      { type: 'secret', role: 'network', value: 'SECRET-network' },
      {
        type: 'totp',
        role: 'username',
        value: { secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30 },
      },
    ];
    for (const templateId of ['login', 'card', 'crypto-wallet']) {
      expect(subtitle(item(templateId, fields))).toBe('');
    }
  });

  it('derives the avatar and the group from the title', () => {
    expect(avatar('garden plan')).toEqual({ initial: 'G', color: avatar('garden plan').color });
    expect(avatar('garden plan').color).toBeGreaterThanOrEqual(0);
    expect(avatar('garden plan').color).toBeLessThan(6);
    expect(new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((t) => avatar(t).color)).size).toBe(
      6,
    );
    expect(avatar('👨‍👩‍👧 fun').initial).toBe('👨‍👩‍👧');
    expect(letter('Érica')).toBe('E');
    expect(letter('ölçek')).toBe('O');
    expect(letter('42 Street')).toBe('#');
    expect(letter('😀')).toBe('#');
  });
});
