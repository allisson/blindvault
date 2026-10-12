// In-memory navigation (D167): no router, nothing in the URL or the history. Screens are plain
// values; `back()` pops the stack.

export type Screen = { readonly name: 'vault' } | { readonly name: 'settings' };

export class Navigation {
  #stack: readonly Screen[] = [{ name: 'vault' }];
  readonly #listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  current = (): Screen => this.#stack[this.#stack.length - 1] ?? { name: 'vault' };

  open(screen: Screen): void {
    this.#stack = [...this.#stack, screen];
    this.#emit();
  }

  back(): void {
    if (this.#stack.length <= 1) return;
    this.#stack = this.#stack.slice(0, -1);
    this.#emit();
  }

  /** Back to the vault root: on lock, nothing of the previous navigation is kept. */
  reset(): void {
    this.#stack = [{ name: 'vault' }];
    this.#emit();
  }

  #emit(): void {
    for (const l of this.#listeners) l();
  }
}
