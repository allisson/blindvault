import { describe, expect, it } from 'vitest';

import { type ShortcutKey, listMove, newItemShortcut, saveShortcut } from './shortcuts';
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

describe('the list movement keys (D251)', () => {
  it('moves down with ↓ or J and up with ↑ or K, with or without caps lock', () => {
    for (const key of ['ArrowDown', 'j', 'J']) expect(listMove({ ...KEY, key }), key).toBe(1);
    for (const key of ['ArrowUp', 'k', 'K']) expect(listMove({ ...KEY, key }), key).toBe(-1);
  });

  it('ignores a modifier and every other key', () => {
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey'] as const) {
      expect(listMove({ ...KEY, key: 'j', [modifier]: true }), modifier).toBeUndefined();
    }
    for (const key of ['n', 'Enter', 'ArrowLeft', ' '])
      expect(listMove({ ...KEY, key })).toBeUndefined();
  });
});

describe('the save shortcut (D251)', () => {
  it('is Ctrl + Enter or ⌘ + Enter', () => {
    expect(saveShortcut({ ...KEY, key: 'Enter', ctrlKey: true })).toBe(true);
    expect(saveShortcut({ ...KEY, key: 'Enter', metaKey: true })).toBe(true);
  });

  it('is not Enter alone, with Shift or Alt, nor another key', () => {
    expect(saveShortcut({ ...KEY, key: 'Enter' })).toBe(false);
    expect(saveShortcut({ ...KEY, key: 'Enter', ctrlKey: true, shiftKey: true })).toBe(false);
    expect(saveShortcut({ ...KEY, key: 'Enter', metaKey: true, altKey: true })).toBe(false);
    expect(saveShortcut({ ...KEY, key: 's', ctrlKey: true })).toBe(false);
  });
});
