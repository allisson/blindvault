// In-memory navigation (D167): no router, nothing in the URL or the history. Screens are plain
// values; `back()` pops the stack. The stack is a list (all items, a folder or the trash), then at
// most a detail of that list (an item, its editor or history, a new item) or Settings.

export type ListScreen =
  | { readonly name: 'vault' }
  | { readonly name: 'trash' }
  | { readonly name: 'folder'; readonly id: Uint8Array };

export type Screen =
  | ListScreen
  /** `focus: 'backup'` puts the cursor in the export's password field (D185, D188). */
  | { readonly name: 'settings'; readonly focus?: 'backup' }
  | { readonly name: 'item'; readonly id: Uint8Array }
  | { readonly name: 'edit'; readonly id: Uint8Array }
  | { readonly name: 'history'; readonly id: Uint8Array }
  | { readonly name: 'new' };

export type DetailScreen = Extract<Screen, { name: 'item' | 'edit' | 'history' | 'new' }>;

export function isDetail(screen: Screen): screen is DetailScreen {
  return (
    screen.name === 'item' ||
    screen.name === 'edit' ||
    screen.name === 'history' ||
    screen.name === 'new'
  );
}

export function isList(screen: Screen): screen is ListScreen {
  return screen.name === 'vault' || screen.name === 'trash' || screen.name === 'folder';
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

const ROOT_LIST: ListScreen = { name: 'vault' };
const ROOT_SCREEN: Screen = ROOT_LIST;
const ROOT: readonly Screen[] = [ROOT_SCREEN];

export class Navigation {
  #stack: readonly Screen[] = ROOT;
  readonly #listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  current = (): Screen => this.#stack.at(-1) ?? ROOT_SCREEN;

  /** Whether a screen sits above the vault root, which the system's back can leave (D197). */
  deeper = (): boolean => this.#stack.length > 1;

  /** The list shown, or that the current detail was selected from. */
  list = (): ListScreen => {
    const top = this.#listStack().at(-1);
    return top && isList(top) ? top : ROOT_LIST;
  };

  open(screen: Screen): void {
    this.#set([...this.#stack, screen]);
  }

  /** The detail of the current list, replacing any other detail. */
  select(screen: DetailScreen): void {
    this.#set([...this.#listStack(), screen]);
  }

  /** A list in place of the current one: all items is the root, the others sit on it. */
  showList(list: ListScreen): void {
    this.#set(list.name === 'vault' ? ROOT : [...ROOT, list]);
  }

  replace(screen: Screen): void {
    this.#set([...this.#stack.slice(0, -1), screen]);
  }

  /** Leaves every screen of item `id`, after it was trashed or restored. */
  close(id: Uint8Array): void {
    const open = this.#stack.some(
      (s) => (s.name === 'item' || s.name === 'edit' || s.name === 'history') && same(s.id, id),
    );
    if (open) this.#set(this.#listStack());
  }

  /** Leaves folder `id`'s list, after it was trashed: back to all items. */
  closeFolder(id: Uint8Array): void {
    if (this.#stack.some((s) => s.name === 'folder' && same(s.id, id))) this.#set(ROOT);
  }

  back(): void {
    if (this.#stack.length <= 1) return;
    this.#set(this.#stack.slice(0, -1));
  }

  /** Back to the vault root: on lock, nothing of the previous navigation is kept. */
  reset(): void {
    this.#set(ROOT);
  }

  /** The stack up to its last list screen; the root is always one. */
  #listStack(): readonly Screen[] {
    let end = this.#stack.length;
    while (end > 1 && !isList(this.#stack[end - 1] ?? ROOT_SCREEN)) end -= 1;
    return this.#stack.slice(0, end);
  }

  #set(stack: readonly Screen[]): void {
    this.#stack = stack;
    for (const l of this.#listeners) l();
  }
}
