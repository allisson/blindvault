/**
 * True when the app runs inside a frame. `window.top` cannot be forged by the framing page, and a
 * detached frame has none. The app then opens nothing (D83, D193).
 */
export function framed(win: { readonly self: unknown; readonly top: unknown }): boolean {
  return win.self !== win.top;
}
