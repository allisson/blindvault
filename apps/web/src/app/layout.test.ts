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

describe('item screens', () => {
  const a = new Uint8Array(16).fill(1);
  const b = new Uint8Array(16).fill(2);

  it('selects a detail under the current list, replacing the previous detail', () => {
    const nav = new Navigation();
    nav.select({ name: 'item', id: a });
    nav.open({ name: 'edit', id: a });
    nav.select({ name: 'item', id: b });
    expect(nav.current()).toEqual({ name: 'item', id: b });
    nav.back();
    expect(nav.current()).toEqual({ name: 'vault' });
  });

  it('keeps the trash as the list a detail was selected from', () => {
    const nav = new Navigation();
    nav.showList({ name: 'trash' });
    expect(nav.list()).toEqual({ name: 'trash' });
    nav.select({ name: 'item', id: a });
    expect(nav.list()).toEqual({ name: 'trash' });
    nav.back();
    expect(nav.current()).toEqual({ name: 'trash' });
    nav.showList({ name: 'vault' });
    expect(nav.current()).toEqual({ name: 'vault' });
    expect(nav.list()).toEqual({ name: 'vault' });
  });

  it('shows a folder as a list over the root, and leaves it once trashed', () => {
    const nav = new Navigation();
    nav.showList({ name: 'folder', id: a });
    nav.showList({ name: 'folder', id: b });
    nav.select({ name: 'item', id: a });
    expect(nav.list()).toEqual({ name: 'folder', id: b });
    nav.closeFolder(a);
    expect(nav.current()).toEqual({ name: 'item', id: a });
    nav.closeFolder(b);
    expect(nav.current()).toEqual({ name: 'vault' });
    nav.back();
    expect(nav.current()).toEqual({ name: 'vault' });
  });

  it('replaces the top screen, as a saved editor becomes the item', () => {
    const nav = new Navigation();
    nav.select({ name: 'new' });
    nav.replace({ name: 'item', id: a });
    expect(nav.current()).toEqual({ name: 'item', id: a });
    nav.back();
    expect(nav.current()).toEqual({ name: 'vault' });
  });

  it('drops the screens of an item that is gone', () => {
    const nav = new Navigation();
    nav.select({ name: 'item', id: a });
    nav.open({ name: 'edit', id: a });
    nav.close(a);
    expect(nav.current()).toEqual({ name: 'vault' });
  });
});
