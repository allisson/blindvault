import { Component, type ReactNode } from 'react';

import { clipboard } from '../app/clipboard';
import { type VaultController } from '../app/controller';
import { useMessages } from '../i18n/context';
import { Button } from './components';
import { Icon } from './icons';

/** The failure screen: nothing of the vault, only a reload. */
function Failure() {
  const m = useMessages();
  return (
    <main
      className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-surface p-6 text-center text-fg"
      data-testid="crash"
    >
      <span className="flex size-14 items-center justify-center rounded-full bg-subtle">
        <Icon name="lock" className="size-6!" />
      </span>
      <h1 className="text-xl font-semibold">{m.crash.title}</h1>
      <p className="max-w-sm text-sm text-muted">{m.crash.text}</p>
      <Button
        onClick={() => {
          location.reload();
        }}
      >
        {m.app.reload}
      </Button>
    </main>
  );
}

/**
 * A render error anywhere under it locks the vault, clearing its plaintext state and the clipboard,
 * before the failure screen paints (D250): `componentDidCatch` runs in the commit, ahead of the
 * browser's paint, and the screens that held plaintext are already unmounted.
 */
export class ErrorBoundary extends Component<
  { readonly controller: VaultController; readonly children: ReactNode },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(): void {
    this.props.controller.lock();
    clipboard.lock();
  }

  override render(): ReactNode {
    return this.state.failed ? <Failure /> : this.props.children;
  }
}
