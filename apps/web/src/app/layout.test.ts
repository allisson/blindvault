import { describe, expect, it } from 'vitest';

import { layoutFor } from './layout';
import { Navigation } from './nav';

describe('layout by width (D15)', () => {
  it.each([
    [320, 'mobile'],
    [639, 'mobile'],
    [640, 'tablet'],
    [1023, 'tablet'],
    [1024, 'desktop'],
    [2560, 'desktop'],
  ])('%i px is %s', (width, layout) => {
    expect(layoutFor(width)).toBe(layout);
  });
});

describe('in-memory navigation (D167)', () => {
  it('opens, goes back, never below the vault, and resets on lock', () => {
    const nav = new Navigation();
    let changes = 0;
    const stop = nav.subscribe(() => (changes += 1));
    nav.back();
    expect(nav.current()).toEqual({ name: 'vault' });
    nav.open({ name: 'settings' });
    expect(nav.current()).toEqual({ name: 'settings' });
    nav.back();
    expect(nav.current()).toEqual({ name: 'vault' });
    nav.open({ name: 'settings' });
    nav.reset();
    expect(nav.current()).toEqual({ name: 'vault' });
    expect(changes).toBe(4);
    stop();
    nav.open({ name: 'settings' });
    expect(changes).toBe(4);
  });
});
