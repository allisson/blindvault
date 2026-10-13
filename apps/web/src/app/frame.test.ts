import { describe, expect, it } from 'vitest';

import { framed } from './frame';

describe('framed app (D83, D193)', () => {
  it('is not framed in a top-level window', () => {
    const win = { self: {}, top: {} };
    win.top = win.self;
    expect(framed(win)).toBe(false);
  });

  it('is framed when the top window is another window, of any origin', () => {
    expect(framed({ self: {}, top: {} })).toBe(true);
  });

  it('is framed when there is no top window, as in a detached frame', () => {
    expect(framed({ self: {}, top: null })).toBe(true);
  });
});
