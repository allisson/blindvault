import { describe, expect, it } from 'vitest';

import { ringTone } from './Totp';

describe('ringTone (D248)', () => {
  it('turns amber from 10 s left and red from 5 s', () => {
    expect([30, 11, 10, 6, 5, 1].map(ringTone)).toEqual([
      'text-accent',
      'text-accent',
      'text-warning',
      'text-warning',
      'text-danger',
      'text-danger',
    ]);
  });
});
