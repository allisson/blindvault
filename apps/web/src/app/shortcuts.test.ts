import { describe, expect, it } from 'vitest';

import { type ShortcutKey, newItemShortcut } from './shortcuts';
import { type Screen } from './nav';

const ID = new Uint8Array([1]);
const KEY: ShortcutKey = {
  key: 'n',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
};
const READY = {
  editing: false,
  screen: { name: 'vault' } as Screen,
  list: { name: 'vault' } as const,
  writable: true,
};

describe('the new item shortcut (D197)', () => {
  it('is N alone, with or without caps lock', () => {
    expect(newItemShortcut(KEY, READY)).toBe(true);
    expect(newItemShortcut({ ...KEY, key: 'N' }, READY)).toBe(true);
  });

  it('is not N with a modifier, nor another key', () => {
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey'] as const) {
      expect(newItemShortcut({ ...KEY, [modifier]: true }, READY), modifier).toBe(false);
    }
    expect(newItemShortcut({ ...KEY, key: 'm' }, READY)).toBe(false);
  });

  it('types into a text field instead', () => {
    expect(newItemShortcut(KEY, { ...READY, editing: true })).toBe(false);
  });

  it('works from a list or an item view', () => {
    for (const screen of [
      { name: 'folder', id: ID },
      { name: 'item', id: ID },
      { name: 'history', id: ID },
    ] as const) {
      expect(newItemShortcut(KEY, { ...READY, screen }), screen.name).toBe(true);
    }
  });

  it('never replaces the editor or Settings, which would lose a draft', () => {
    for (const screen of [
      { name: 'edit', id: ID },
      { name: 'new' },
      { name: 'settings' },
    ] as const) {
      expect(newItemShortcut(KEY, { ...READY, screen }), screen.name).toBe(false);
    }
  });

  it('does nothing in the trash or in a read-only vault, where New item is not offered', () => {
    expect(
      newItemShortcut(KEY, { ...READY, screen: { name: 'trash' }, list: { name: 'trash' } }),
    ).toBe(false);
    expect(newItemShortcut(KEY, { ...READY, writable: false })).toBe(false);
  });
});
