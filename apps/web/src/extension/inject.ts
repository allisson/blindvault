// The function the session host runs in a page's frames, in the extension's isolated world
// (extension.md §6.1, D283, D287): to probe a frame for a sign-in field, then to fill one. The browser
// serializes it for `scripting.executeScript`, so it is self-contained: it uses nothing outside its
// own body, and takes and returns plain data.

/** What the session host asks of a frame. */
export type InPageOrder =
  | { readonly kind: 'probe' }
  | {
      readonly kind: 'fill';
      /** The top frame's origin, read from the browser before the probe. */
      readonly origin: string;
      readonly username?: string;
      readonly password?: string;
    };

/** A frame's sign-in fields, as a probe sees them. */
export interface ProbeResult {
  readonly origin: string;
  /** A password field the fill can use. */
  readonly password: boolean;
  /** That field has the focus. */
  readonly focusedPassword: boolean;
  /** The focus is on a text, email or telephone field, a user name's (D287). */
  readonly focusedText: boolean;
}

/** What a fill did: `moved` when the frame left the expected origin since the probe. */
export type FillResult = 'filled' | 'no-target' | 'moved';

/**
 * Runs in the page. A probe reports the frame's fields; a fill writes the values into them, only
 * while `location.origin` is still the expected one, and never submits, clicks or presses a key.
 */
export function inPage(order: InPageOrder): ProbeResult | FillResult {
  const TEXT = ['text', 'email', 'tel'];

  /** Every input of the document and its open shadow roots, in document order. */
  function inputs(): HTMLInputElement[] {
    const found: HTMLInputElement[] = [];
    const walk = (root: Document | ShadowRoot) => {
      for (const el of Array.from(root.querySelectorAll('*'))) {
        if (el instanceof HTMLInputElement) found.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    return found;
  }

  /**
   * Whether the user can see the field: a box of some size, and neither it nor an ancestor, across
   * open shadow roots, fully transparent (E-03). A field outside the viewport is still visible: a
   * sign-in form below the fold is filled.
   */
  function visible(el: HTMLInputElement): boolean {
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return false;
    let node: Element | null = el;
    while (node) {
      if (Number(getComputedStyle(node).opacity) === 0) return false;
      node = node.parentElement ?? (node.getRootNode() as Partial<ShadowRoot>).host ?? null;
    }
    return true;
  }

  function usable(el: HTMLInputElement): boolean {
    return (
      !el.disabled &&
      !el.readOnly &&
      el.getClientRects().length > 0 &&
      getComputedStyle(el).visibility !== 'hidden' &&
      visible(el)
    );
  }

  function autocomplete(el: HTMLInputElement): string[] {
    return (el.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/);
  }

  /** The focused element, through open shadow roots. */
  function focused(): Element | null {
    let el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }

  const all = inputs().filter(usable);
  const active = focused();
  const passwords = all.filter((el) => el.type === 'password');
  const texts = all.filter((el) => TEXT.includes(el.type));

  // The focused password field, else the first one not meant for a new password (D287).
  const password =
    passwords.find((el) => el === active) ??
    passwords.find((el) => !autocomplete(el).includes('new-password'));
  const focusedText = texts.find((el) => el === active);

  if (order.kind === 'probe') {
    return {
      origin: location.origin,
      password: password !== undefined,
      focusedPassword: password !== undefined && password === active,
      focusedText: focusedText !== undefined,
    };
  }

  // A navigation between the probe and the fill: write nothing.
  if (location.origin !== order.origin) return 'moved';

  /** The user name's field: `autocomplete="username"`, else the last text field before the password's. */
  function usernameField(): HTMLInputElement | undefined {
    if (!password) return focusedText;
    const scope = texts.filter((el) => (password.form ? el.form === password.form : true));
    const named = scope.find((el) => autocomplete(el).includes('username'));
    if (named) return named;
    const at = all.indexOf(password);
    return scope.filter((el) => all.indexOf(el) < at).pop();
  }

  function write(el: HTMLInputElement, value: string): void {
    // The prototype's native setter, past any the page defined on the element, so a page's
    // framework sees the change through the events.
    Reflect.set(HTMLInputElement.prototype, 'value', value, el);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  let wrote = false;
  const user = order.username === undefined ? undefined : usernameField();
  if (user && order.username !== undefined) {
    write(user, order.username);
    wrote = true;
  }
  if (password && order.password !== undefined) {
    write(password, order.password);
    wrote = true;
  }
  return wrote ? 'filled' : 'no-target';
}
