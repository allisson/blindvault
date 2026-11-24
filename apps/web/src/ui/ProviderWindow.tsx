import { type ReactNode, useSyncExternalStore } from 'react';

import { type VaultController } from '../app/controller';
import { type ProviderFlow, type ProviderState, type Unbound } from '../app/provider-flow';
import { useMessages } from '../i18n/context';
import { type Messages, format } from '../i18n/messages';
import { Button, Card, Field, Notice, TARGET } from './components';
import { ConfirmRequest, Row } from './Confirm';
import { Unlock } from './Start';

/** Why an app's domain does not bind it (§7.4, D303). */
function why(m: Messages, unbound: Unbound): string | undefined {
  switch (unbound.binding) {
    case 'unbound':
      return m.confirm.unboundNone;
    case 'redirect':
      return m.confirm.unboundRedirect;
    case 'network':
      return m.confirm.unboundNetwork;
    case undefined:
      return undefined;
  }
}

/**
 * The Android provider window (android.md §7.1, D301, D303): the unlock, then who asks and the user's
 * tap. It offers no way to replace or erase the vault, which is the main window's work.
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
  const browser = (
    <Button
      variant="secondary"
      onClick={() => {
        flow.choose({ choice: 'browser' });
      }}
    >
      {m.confirm.browser}
    </Button>
  );
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
    case 'binding':
      return <Card title={m.app.name}>{format(m.confirm.binding, { domain: state.domain })}</Card>;
    case 'unbound': {
      const reason = why(m, state.unbound);
      return (
        <Card title={m.app.name}>
          <p className="text-sm" data-testid="provider-unbound">
            {format(m.confirm.unbound, {
              app: state.packageName,
              domain: state.unbound.domains.join(', '),
            })}
          </p>
          {reason === undefined ? null : <p className="text-sm text-muted">{reason}</p>}
          {browser}
          {cancel}
        </Card>
      );
    }
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
            app={state.app}
            busy={state.busy}
            choose={(choice) => {
              flow.choose(choice);
            }}
          />
          {state.note === undefined ? null : <Notice>{m.confirm.failed}</Notice>}
        </main>
      );
    case 'password':
      return (
        <Password state={state} flow={flow}>
          {browser}
          {cancel}
        </Password>
      );
  }
}

/**
 * A password request (§7.6, D303): who asks, the logins it may get, and the user's tap on one. An
 * app searches the Login items; a browser sees those of its origin.
 */
function Password({
  state,
  flow,
  children,
}: {
  readonly state: Extract<ProviderState, { kind: 'password' }>;
  readonly flow: ProviderFlow;
  readonly children: ReactNode;
}) {
  const m = useMessages();
  const { caller, note } = state;
  const app = caller.kind === 'app';
  let notice: string | undefined;
  if (note === 'not-found') {
    notice = m.confirm.failed;
  } else if (note !== undefined) {
    notice =
      note.domains.length === 0
        ? m.confirm.passwordNoDomain
        : [
            format(m.confirm.passwordUnbound, {
              app: app ? caller.packageName : '',
              domains: note.domains.join(', '),
            }),
            why(m, note),
          ]
            .filter(Boolean)
            .join(' ');
  }
  return (
    <main data-testid="provider" className="flex min-h-dvh flex-col gap-3 bg-surface p-4 text-fg">
      <header className="text-sm font-semibold">{m.app.name}</header>
      <h1 className="text-title">{m.confirm.passwordTitle}</h1>
      <dl className="flex flex-col gap-2">
        {app ? (
          <Row label={m.confirm.app}>{caller.packageName}</Row>
        ) : (
          <Row label={m.confirm.site}>{caller.origin}</Row>
        )}
      </dl>
      {app ? (
        <Field
          label={m.confirm.search}
          type="search"
          value={state.query}
          onChange={(e) => {
            flow.search(e.target.value);
          }}
        />
      ) : null}
      {state.logins.length === 0 ? (
        <p className="text-sm">{m.confirm.noLogins}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {state.logins.map((l) => (
            <li key={l.itemId}>
              <button
                type="button"
                disabled={state.busy}
                className={`${TARGET} flex w-full flex-col items-start rounded-control bg-raised p-2 text-start text-sm disabled:opacity-50`}
                onClick={() => {
                  void flow.pick(l.itemId);
                }}
              >
                <span className="font-medium break-words">{l.title}</span>
                <span className="text-xs text-muted break-all">{l.userName}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {notice === undefined ? null : <Notice>{notice}</Notice>}
      {children}
    </main>
  );
}
