import { describe, expect, it } from 'vitest';

import { Navigation } from './nav';

const ID = new Uint8Array([1, 2, 3]);
const OTHER = new Uint8Array([4, 5, 6]);

/** Whether `follow` from `from` runs its step after `move`. */
function follows(nav: Navigation, move: () => void): boolean {
  const from = nav.current();
  move();
  let ran = false;
  nav.follow(from, () => {
    ran = true;
  });
  return ran;
}

describe('navigation after a write (D210)', () => {
  it('follows when the screen the write started from is still current', () => {
    const nav = new Navigation();
    nav.select({ name: 'new' });
    expect(follows(nav, () => undefined)).toBe(true);
  });

  it('follows when the user left and came back to the same screen', () => {
    const nav = new Navigation();
    nav.select({ name: 'item', id: ID });
    expect(
      follows(nav, () => {
        nav.open({ name: 'settings' });
        nav.back();
      }),
    ).toBe(true);
  });

  it('does not follow once the user went elsewhere', () => {
    const moves: [string, (nav: Navigation) => void][] = [
      [
        'a new item',
        (nav) => {
          nav.select({ name: 'new' });
        },
      ],
      [
        'another item',
        (nav) => {
          nav.select({ name: 'item', id: OTHER });
        },
      ],
      [
        'the same item, selected again',
        (nav) => {
          nav.select({ name: 'item', id: ID });
        },
      ],
      [
        'Settings',
        (nav) => {
          nav.open({ name: 'settings' });
        },
      ],
      [
        'its editor',
        (nav) => {
          nav.open({ name: 'edit', id: ID });
        },
      ],
      [
        'back',
        (nav) => {
          nav.back();
        },
      ],
      [
        'the trash',
        (nav) => {
          nav.showList({ name: 'trash' });
        },
      ],
      [
        'a replacement',
        (nav) => {
          nav.replace({ name: 'history', id: ID });
        },
      ],
      [
        'a lock',
        (nav) => {
          nav.reset();
        },
      ],
    ];
    for (const [name, move] of moves) {
      const nav = new Navigation();
      nav.select({ name: 'item', id: ID });
      expect(
        follows(nav, () => {
          move(nav);
        }),
        name,
      ).toBe(false);
    }
  });

  it('gives each New item its own opening, kept while it stays open', () => {
    const nav = new Navigation();
    nav.select({ name: 'new' });
    const first = nav.opening(nav.current());
    expect(nav.opening(nav.current())).toBe(first);
    nav.open({ name: 'settings' });
    nav.back();
    expect(nav.opening(nav.current())).toBe(first);
    nav.select({ name: 'new' });
    expect(nav.opening(nav.current())).not.toBe(first);
  });
});
