import { describe, expect, it, vi } from 'vitest';

import { clipboard } from '../app/clipboard';
import { type VaultController } from '../app/controller';
import { ErrorBoundary } from './ErrorBoundary';

// A render error locks the vault and clears the clipboard in the commit, before the failure
// screen paints (D250). What the lock clears is tested in controller.test.ts; the screen, in
// e2e/feedback.spec.ts.

describe('the error boundary (D250)', () => {
  it('locks the vault and clears the clipboard when it catches, then renders no child', () => {
    const lock = vi.fn();
    const clear = vi.spyOn(clipboard, 'lock').mockImplementation(() => undefined);
    const children = 'the vault';
    const boundary = new ErrorBoundary({
      controller: { lock } as unknown as VaultController,
      children,
    });
    expect(boundary.render()).toBe(children);

    boundary.state = ErrorBoundary.getDerivedStateFromError();
    boundary.componentDidCatch();
    expect(lock).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledOnce();
    expect(boundary.render()).not.toBe(children);
  });
});
