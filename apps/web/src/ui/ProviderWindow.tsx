import { useSyncExternalStore } from 'react';

import { type VaultController } from '../app/controller';
import { type ProviderFlow } from '../app/provider-flow';
import { useMessages } from '../i18n/context';
import { Button, Card, Notice } from './components';
import { ConfirmRequest } from './Confirm';
import { Unlock } from './Start';

/**
 * The Android provider window (android.md §7.1, D301): the unlock, then who asks and the user's tap.
 * It offers no way to replace or erase the vault, which is the main window's work.
 */
export function ProviderWindow({
  controller,
  flow,
}: {
  readonly controller: VaultController;
  readonly flow: ProviderFlow;
}) {
  const m = useMessages();
  const state = useSyncExternalStore(flow.subscribe, flow.getState);
  const status = useSyncExternalStore(controller.subscribe, controller.getStatus);
  const cancel = (
    <Button
      variant="quiet"
      onClick={() => {
        flow.choose({ choice: 'cancel' });
      }}
    >
      {m.confirm.cancel}
    </Button>
  );
  switch (state.kind) {
    case 'loading':
      return <Card title={m.app.name}>{m.start.starting}</Card>;
    case 'ended':
      return <Card title={m.app.name}>{m.confirm.ended}</Card>;
    case 'no-vault':
      return (
        <Card title={m.app.name}>
          <p className="text-sm">{m.confirm.noVault}</p>
          {cancel}
        </Card>
      );
    case 'unlock':
      // Inside the card, which fills the screen: below it, Cancel would be out of sight.
      return (
        <Unlock controller={controller} working={status.kind === 'unlocking'}>
          {cancel}
        </Unlock>
      );
    case 'confirm':
      return (
        <main
          data-testid="provider"
          className="flex min-h-dvh flex-col gap-3 bg-surface p-4 text-fg"
        >
          <header className="text-sm font-semibold">{m.app.name}</header>
          <ConfirmRequest
            state={state.state}
            busy={state.busy}
            choose={(choice) => {
              flow.choose(choice);
            }}
          />
          {state.note === undefined ? null : <Notice>{m.confirm.failed}</Notice>}
        </main>
      );
  }
}
