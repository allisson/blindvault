import { describe, expect, it } from 'vitest';

import { level, rated } from './Strength';

describe('item password strength (D249)', () => {
  it('maps scores 0 to 2 to weak, 3 to fair and 4 to strong', () => {
    expect(([0, 1, 2, 3, 4] as const).map(level)).toEqual([
      'weak',
      'weak',
      'weak',
      'fair',
      'strong',
    ]);
  });

  it('rates a password secret only, not a PIN, a TOTP or a custom secret', () => {
    expect(rated({ role: 'password', type: 'secret' })).toBe(true);
    expect(rated({ role: 'pin', type: 'secret' })).toBe(false);
    expect(rated({ role: 'password', type: 'totp' })).toBe(false);
    expect(rated({ type: 'secret' })).toBe(false);
  });
});
