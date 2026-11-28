import { Component, type ReactNode } from 'react';

import { clipboard } from '../app/clipboard';
import { type VaultController } from '../app/controller';
import { useMessages } from '../i18n/context';
import { Button, CardMark } from './components';

/** The failure screen: nothing of the vault, only a reload. */
function Failure() {
  const m = useMessages();
  return (
    <main
      className="flex min-h-dvh items-center justify-center bg-surface p-4 text-fg"
      data-testid="crash"
    >
      <section className="flex w-full max-w-md flex-col gap-4 rounded-card bg-raised p-6 shadow-raised">
        <p className="text-sm font-semibold">{m.app.name}</p>
        <CardMark name="circle-alert" tone="danger" />
        <h1 className="text-title">{m.crash.title}</h1>
        <p className="text-muted">{m.crash.text}</p>
        <Button
          className="self-start"
          onClick={() => {
            location.reload();
          }}
        >
          {m.app.reload}
        </Button>
      </section>
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
