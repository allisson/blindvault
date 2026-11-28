// In-memory navigation (D167): no router, nothing in the URL or the history. Screens are plain
// values; `back()` pops the stack. The stack is a list (all items, a folder or the trash), then at
// most a detail of that list (an item, its editor or history, a new item) or Settings.

export type ListScreen =
  | { readonly name: 'vault' }
  | { readonly name: 'trash' }
  | { readonly name: 'folder'; readonly id: Uint8Array };

/** Where Devices puts the cursor: in the pairing or the re-admission, already open (D234). */
export type DevicesFocus = 'pair' | 'readmit';

/**
 * Where Settings puts the cursor: `backup` in the export's password field (D185, D188), the others
 * at their section, from "Vault ready" (D198). `devices` and a `DevicesFocus` open Devices, a main
 * destination of its own (D316).
 */
export type SettingsFocus =
  'backup' | 'passkey' | 'recovery' | 'devices' | DevicesFocus | 'refound' | 'import';

/** A page of Settings, opened from its index (D252). */
export type SettingsPage =
  | 'appearance'
  | 'language'
  | 'locking'
  | 'password'
  | 'passkey'
  | 'sitePasskeys'
  | 'recovery'
  | 'backup'
  | 'merge'
  | 'import'
  | 'storage'
  | 'refound'
  | 'erase'
  | 'about';

/** The page each focus of Settings is on. */
export const FOCUS_PAGE: Readonly<
  Record<Exclude<SettingsFocus, 'devices' | DevicesFocus>, SettingsPage>
> = {
  backup: 'backup',
  passkey: 'passkey',
  recovery: 'recovery',
  refound: 'refound',
  import: 'import',
};

/** The main destinations besides the lists, each over the list it was opened from (D316). */
export type MainScreen =
  | {
      readonly name: 'settings';
      readonly page?: SettingsPage;
      readonly focus?: SettingsFocus;
    }
  | { readonly name: 'devices'; readonly focus?: DevicesFocus }
  | { readonly name: 'notices' };

export type Screen =
  | ListScreen
  | MainScreen
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

export function isMain(screen: Screen): screen is MainScreen {
  return screen.name === 'settings' || screen.name === 'devices' || screen.name === 'notices';
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

/**
 * Asked before a navigation leaves the current screen: returns true to hold it, and then calls
 * `proceed` once the user agrees to leave.
 */
export type LeaveGuard = (proceed: () => void) => boolean;

export class Navigation {
  #stack: readonly Screen[] = ROOT;
  readonly #listeners = new Set<() => void>();
  readonly #openings = new WeakMap<Screen, number>();
  #opened = 0;
  #guard: LeaveGuard | undefined;

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

  /**
   * Runs `step` only while `from`, the screen a write started from, is still current: a write that
   * completes after the user went elsewhere leaves them there (D210). Every navigation makes a new
   * screen value, so the same item selected again is another screen.
   */
  follow(from: Screen, step: () => void): void {
    if (this.current() === from) step();
  }

  /**
   * An editor with unsaved changes asks before any navigation leaves it (D234). A lock never asks:
   * `reset` and the closing of a trashed item go through. Returns the removal.
   */
  guard(guard: LeaveGuard): () => void {
    this.#guard = guard;
    return () => {
      if (this.#guard === guard) this.#guard = undefined;
    };
  }

  /** A number per opening of a screen, so each New item is a fresh editor (D210). */
  opening = (screen: Screen): number => {
    let n = this.#openings.get(screen);
    if (n === undefined) {
      n = ++this.#opened;
      this.#openings.set(screen, n);
    }
    return n;
  };

  open(screen: Screen): void {
    this.#set([...this.#stack, screen]);
  }

  /**
   * Settings over the screens below it: its index, then the page `focus` is on, so back from the
   * page leads to the index (D252). Any main destination already open is replaced. Devices is one
   * of its own (D316): `devices`, `pair` and `readmit` open it.
   */
  openSettings(focus?: SettingsFocus): void {
    if (focus === 'devices' || focus === 'pair' || focus === 'readmit') {
      this.openMain(focus === 'devices' ? { name: 'devices' } : { name: 'devices', focus });
      return;
    }
    const below = this.#belowMain();
    const index: Screen = { name: 'settings' };
    this.#set(
      focus
        ? [...below, index, { name: 'settings', page: FOCUS_PAGE[focus], focus }]
        : [...below, index],
    );
  }

  /** A main destination over the screens below it, in place of any already open (D316). */
  openMain(screen: MainScreen): void {
    this.#set([...this.#belowMain(), screen]);
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
    if (open) this.#set(this.#listStack(), true);
  }

  /** Leaves folder `id`'s list, after it was trashed: back to all items. */
  closeFolder(id: Uint8Array): void {
    if (this.#stack.some((s) => s.name === 'folder' && same(s.id, id))) this.#set(ROOT, true);
  }

  back(): void {
    if (this.#stack.length <= 1) return;
    this.#set(this.#stack.slice(0, -1));
  }

  /** Back to the vault root: on lock, nothing of the previous navigation is kept. */
  reset(): void {
    this.#set(ROOT, true);
  }

  /** The stack without its main destinations. */
  #belowMain(): readonly Screen[] {
    const below = this.#stack.filter((s) => !isMain(s));
    return below.length > 0 ? below : ROOT;
  }

  /** The stack up to its last list screen; the root is always one. */
  #listStack(): readonly Screen[] {
    let end = this.#stack.length;
    while (end > 1 && !isList(this.#stack[end - 1] ?? ROOT_SCREEN)) end -= 1;
    return this.#stack.slice(0, end);
  }

  #set(stack: readonly Screen[], force = false): void {
    const guard = this.#guard;
    if (!force && guard && stack.at(-1) !== this.current()) {
      const held = guard(() => {
        if (this.#guard === guard) this.#guard = undefined;
        this.#set(stack, true);
      });
      if (held) {
        // Still on the same screen: listeners resync, so the system's back pushes its entry again.
        for (const l of this.#listeners) l();
        return;
      }
    }
    this.#stack = stack;
    for (const l of this.#listeners) l();
  }
}
