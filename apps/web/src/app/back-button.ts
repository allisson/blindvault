// The system's back (D167, D197): while the navigation is deeper than the vault root, the history
// holds exactly one entry the app pushed, with no state and the same URL. Going back in the history
// takes the navigation one screen back; nothing of the vault ever enters the history.

import { type Navigation } from './nav';

/** What the app uses of `history`, with `window`'s `popstate`. */
export interface HistoryLike {
  pushState(data: null, unused: string): void;
  back(): void;
  addEventListener(type: 'popstate', listener: () => void): void;
  removeEventListener(type: 'popstate', listener: () => void): void;
}

/** The browser's history: the only place the app pushes an entry, which carries nothing (D197). */
export function browserHistory(): HistoryLike {
  return {
    pushState: (data, unused) => {
      // eslint-disable-next-line no-restricted-properties -- D197: no state and no URL, so nothing of the vault (D167).
      history.pushState(data, unused);
    },
    back: () => {
      history.back();
    },
    addEventListener: (type, listener) => {
      window.addEventListener(type, listener);
    },
    removeEventListener: (type, listener) => {
      window.removeEventListener(type, listener);
    },
  };
}

export class BackButton {
  readonly #nav: Navigation;
  readonly #history: HistoryLike;
  /** Whether the entry the app pushed is the current one. */
  #pushed = false;
  /** The app's own `back()` calls the browser has not answered yet. */
  #expected = 0;

  constructor(nav: Navigation, history: HistoryLike) {
    this.#nav = nav;
    this.#history = history;
  }

  start(): () => void {
    const off = this.#nav.subscribe(this.#follow);
    this.#history.addEventListener('popstate', this.#pop);
    return () => {
      off();
      this.#history.removeEventListener('popstate', this.#pop);
    };
  }

  #follow = (): void => {
    const deeper = this.#nav.deeper();
    if (deeper && !this.#pushed) {
      // No state and no URL: the entry says nothing of the screen (D167).
      this.#history.pushState(null, '');
      this.#pushed = true;
    } else if (!deeper && this.#pushed) {
      // The app returned to the root itself: remove the entry, so the next back leaves the app.
      this.#pushed = false;
      this.#expected += 1;
      this.#history.back();
    }
  };

  #pop = (): void => {
    this.#pushed = false;
    if (this.#expected > 0) {
      // The answer to the app's own back. If the app went deeper meanwhile, the entry it pushed
      // may be the one removed: push it again.
      this.#expected -= 1;
      this.#follow();
      return;
    }
    // The user went back: one screen back, which pushes the entry again while still deeper.
    this.#nav.back();
  };
}
