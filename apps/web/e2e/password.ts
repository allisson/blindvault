// Filling a password field, checked. Playwright's `fill` focuses the field in one call and types into
// whatever has the focus in the next, without checking: a field recreated or a focus moved in
// between loses the text silently, and the test then waits on a disabled button until it times out.

import { type Locator } from '@playwright/test';

interface Watch {
  readonly field: Element;
  focus?: string;
}

/**
 * Fills `field` with `value`, then fails at once, saying whether the field was recreated or the
 * focus moved, when the value did not land. No retry: a screen that drops what was typed is a bug
 * to catch. The value is never part of the error.
 */
export async function fillPassword(field: Locator, value: string): Promise<void> {
  await field.evaluate((el) => {
    const w = window as unknown as { __fillPassword?: Watch };
    // The element itself, not an attribute: a clone would copy an attribute.
    const watch: Watch = { field: el };
    w.__fillPassword = watch;
    el.addEventListener(
      'focusout',
      (e) => {
        const to = e instanceof FocusEvent ? e.relatedTarget : null;
        watch.focus =
          to instanceof Element
            ? `${to.tagName}${to.hasAttribute('data-testid') ? `[data-testid="${to.getAttribute('data-testid') ?? ''}"]` : ''}`
            : 'nothing';
      },
      { once: true },
    );
  });
  await field.fill(value);
  const landed = (await field.inputValue()) === value;
  const { same, focus } = await field.evaluate((el) => {
    const w = window as unknown as { __fillPassword?: Watch };
    const watch = w.__fillPassword;
    delete w.__fillPassword;
    return { same: watch?.field === el, focus: watch?.focus };
  });
  if (landed) return;
  const why = !same
    ? 'the field was recreated after it was focused'
    : focus !== undefined
      ? `the focus moved to ${focus} after the field was focused`
      : 'neither the field was recreated nor the focus moved';
  throw new Error(`The password did not land in the field: ${why}.`);
}
