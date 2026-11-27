// The input delay of a passkey confirmation (extension.md §7.4, P-02): Confirm stays disabled for a
// moment after the window shows and after each time it takes the focus, as a browser's permission
// prompt does, so a click a page drew onto the spot where the window appears is not the user
// presence.

/** How long Confirm stays disabled, in ms. */
export const INPUT_DELAY_MS = 500;

/**
 * Calls `set(false)` now and on each `focus` of `target`, then `set(true)` once `ms` passed without
 * another. The function returned stops it.
 */
export function armAfterDelay(
  target: EventTarget,
  set: (armed: boolean) => void,
  ms = INPUT_DELAY_MS,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const restart = () => {
    set(false);
    clearTimeout(timer);
    timer = setTimeout(() => {
      set(true);
    }, ms);
  };
  restart();
  target.addEventListener('focus', restart);
  return () => {
    clearTimeout(timer);
    target.removeEventListener('focus', restart);
  };
}
