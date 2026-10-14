// Keyboard shortcuts, in every layout (overview §13.1, D197): Ctrl/⌘ + K and Ctrl/⌘ + Shift + L
// are handled where they act; N alone starts a new item, under the rules below.

import { type ListScreen, type Screen } from './nav';

export type ShortcutKey = Pick<
  KeyboardEvent,
  'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'
>;

/**
 * N alone, outside a text field, from a list or an item view: never from the editor or Settings,
 * which would lose a draft, nor where New item is not offered (the trash, a read-only vault).
 */
export function newItemShortcut(
  e: ShortcutKey,
  context: {
    readonly editing: boolean;
    readonly screen: Screen;
    readonly list: ListScreen;
    readonly writable: boolean;
  },
): boolean {
  if (e.key.toLowerCase() !== 'n' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) {
    return false;
  }
  const { screen } = context;
  const from =
    screen.name === 'vault' ||
    screen.name === 'folder' ||
    screen.name === 'item' ||
    screen.name === 'history';
  return !context.editing && from && context.list.name !== 'trash' && context.writable;
}
