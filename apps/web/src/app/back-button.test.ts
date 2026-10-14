import { describe, expect, it } from 'vitest';

import { BackButton, type HistoryLike } from './back-button';
import { Navigation } from './nav';

/** A history whose `back()` answers later, as a browser's does, through `pop()`. */
class FakeHistory implements HistoryLike {
  readonly pushed: unknown[][] = [];
  backs = 0;
  readonly #listeners = new Set<() => void>();

  pushState(...args: [data: null, unused: string]): void {
    this.pushed.push(args);
  }

  back(): void {
    this.backs += 1;
  }

  addEventListener(_type: 'popstate', listener: () => void): void {
    this.#listeners.add(listener);
  }

  removeEventListener(_type: 'popstate', listener: () => void): void {
    this.#listeners.delete(listener);
  }

  /** The browser went back one entry: by the user, or answering `back()`. */
  pop(): void {
    for (const l of this.#listeners) l();
  }
}

const ID = new Uint8Array([1, 2, 3]);

function setup() {
  const nav = new Navigation();
  const history = new FakeHistory();
  const button = new BackButton(nav, history);
  const stop = button.start();
  return { nav, history, stop };
}

describe('system back (D167, D197)', () => {
  it('pushes one entry with no state and no URL when the navigation leaves the root', () => {
    const { nav, history } = setup();
    expect(history.pushed).toEqual([]);
    nav.select({ name: 'item', id: ID });
    expect(history.pushed).toEqual([[null, '']]);
    // Deeper still: no second entry.
    nav.select({ name: 'edit', id: ID });
    nav.open({ name: 'settings' });
    expect(history.pushed).toHaveLength(1);
  });

  it('pushes nothing for a list screen that sits on the root, nor for a replaced screen', () => {
    const { nav, history } = setup();
    nav.showList({ name: 'vault' });
    expect(history.pushed).toEqual([]);
    nav.showList({ name: 'trash' });
    nav.replace({ name: 'trash' });
    expect(history.pushed).toHaveLength(1);
  });

  it('takes the navigation one screen back on a system back, and pushes again while deeper', () => {
    const { nav, history } = setup();
    nav.showList({ name: 'trash' });
    nav.select({ name: 'item', id: ID });
    history.pop();
    expect(nav.current()).toEqual({ name: 'trash' });
    expect(history.pushed).toHaveLength(2);
    history.pop();
    expect(nav.current()).toEqual({ name: 'vault' });
    // At the root: the next system back leaves the app.
    expect(history.pushed).toHaveLength(2);
    expect(history.backs).toBe(0);
  });

  it('removes its entry when the app returns to the root, ignoring the answer', () => {
    const { nav, history } = setup();
    nav.select({ name: 'item', id: ID });
    nav.back();
    expect(history.backs).toBe(1);
    // The browser answers the app's own back: the navigation does not move again.
    nav.open({ name: 'settings' });
    nav.back();
    expect(history.backs).toBe(2);
    history.pop();
    history.pop();
    expect(nav.current()).toEqual({ name: 'vault' });
  });

  it('removes its entry on lock, when the navigation is reset', () => {
    const { nav, history } = setup();
    nav.showList({ name: 'trash' });
    nav.select({ name: 'item', id: ID });
    nav.reset();
    expect(history.backs).toBe(1);
    history.pop();
    expect(nav.current()).toEqual({ name: 'vault' });
  });

  it('pushes again when the app went deeper before the browser answered its back', () => {
    const { nav, history } = setup();
    nav.select({ name: 'item', id: ID });
    nav.back();
    nav.open({ name: 'settings' });
    // The answer removed the entry pushed for Settings: push it again, and stay.
    history.pop();
    expect(nav.current()).toEqual({ name: 'settings' });
    expect(history.pushed).toHaveLength(3);
  });

  it('does nothing on a system back at the root', () => {
    const { nav, history } = setup();
    history.pop();
    expect(nav.current()).toEqual({ name: 'vault' });
    expect(history.pushed).toEqual([]);
    expect(history.backs).toBe(0);
  });

  it('stops following the navigation and the history once stopped', () => {
    const { nav, history, stop } = setup();
    stop();
    nav.select({ name: 'item', id: ID });
    expect(history.pushed).toEqual([]);
    history.pop();
    expect(nav.current()).toEqual({ name: 'item', id: ID });
  });
});
