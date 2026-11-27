import { type ReactNode, useCallback, useEffect, useId, useState } from 'react';

import { armAfterDelay } from '../app/input-delay';
import { confirmChoice, confirmDetails } from '../extension/confirm-client';
import { type PopupRuntime, openHost } from '../extension/popup-client';
import { type ConfirmChoice, type ConfirmState } from '../extension/rpc';
import { useMessages } from '../i18n/context';
import { format } from '../i18n/messages';
import { Button, Notice, TARGET } from './components';

/**
 * The passkey confirmation window (extension.md §7.4, D268, D289): a page of the extension's origin,
 * which the site can neither cover nor click. It shows the request the session host holds under
 * its token and sends the user's choice; the click on Confirm is the user presence. It holds no key.
 */
export function Confirm({
  runtime,
  token,
  close,
}: {
  readonly runtime: PopupRuntime;
  readonly token: string;
  readonly close: () => void;
}) {
  const m = useMessages();
  const [state, setState] = useState<ConfirmState | 'ended' | 'loading'>('loading');
  const [note, setNote] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void confirmDetails(runtime, token).then((result) => {
      if (typeof result === 'object') setState(result);
      else if (result === 'not-found') setState('ended');
      else setNote(m.confirm.failed);
    });
  }, [runtime, token, m]);

  useEffect(load, [load]);

  const choose = (choice: ConfirmChoice) => {
    setBusy(true);
    void confirmChoice(runtime, token, choice).then((result) => {
      setBusy(false);
      // The session host closes the window once the request ends; this covers a refused close.
      if (result === true) close();
      else if (result === 'not-found') setState('ended');
      else if (result === 'locked') load();
      else setNote(m.confirm.failed);
    });
  };

  const others = (
    <>
      <Button
        variant="secondary"
        disabled={busy}
        onClick={() => {
          choose({ choice: 'browser' });
        }}
      >
        {m.confirm.browser}
      </Button>
      <Button
        variant="quiet"
        disabled={busy}
        onClick={() => {
          choose({ choice: 'cancel' });
        }}
      >
        {m.confirm.cancel}
      </Button>
    </>
  );

  let body: ReactNode = null;
  if (state === 'ended') {
    body = (
      <>
        <p className="text-sm">{m.confirm.ended}</p>
        <Button variant="secondary" onClick={close}>
          {m.confirm.close}
        </Button>
      </>
    );
  } else if (state !== 'loading' && state.kind === 'locked') {
    body = (
      <>
        <p className="text-sm">{m.confirm.locked}</p>
        <Button
          variant="primary"
          onClick={() => {
            void openHost(runtime);
          }}
        >
          {m.confirm.unlock}
        </Button>
        {others}
      </>
    );
  } else if (state !== 'loading') {
    body = <ConfirmRequest state={state} busy={busy} choose={choose} />;
  }

  return (
    <main data-testid="confirm" className="flex min-h-dvh flex-col gap-3 bg-surface p-4 text-fg">
      <header className="text-sm font-semibold">{m.app.name}</header>
      {body}
      {note === undefined ? null : <Notice>{note}</Notice>}
    </main>
  );
}

/**
 * A get or create waiting for the user (extension.md §7.4): who asks, the passkeys or the items to
 * save in, Confirm, another authenticator and Cancel. Shared by the extension's confirmation window
 * and the Android provider window (android.md §7.1); the click on Confirm is the user presence.
 */
export function ConfirmRequest({
  state,
  app,
  busy,
  choose,
}: {
  readonly state: Exclude<ConfirmState, { kind: 'locked' }>;
  /** An Android app's package, shown in place of the site (android.md §7.5, D303). */
  readonly app?: string | undefined;
  readonly busy: boolean;
  readonly choose: (choice: ConfirmChoice) => void;
}) {
  const m = useMessages();
  const [picked, setPicked] = useState<string>();
  // Confirm waits a moment after the request shows and after each focus (P-02).
  const [armed, setArmed] = useState(false);
  useEffect(() => armAfterDelay(window, setArmed), []);
  const none = state.kind === 'get' && state.passkeys.length === 0;
  const others = (
    <>
      <Button
        variant={none ? 'primary' : 'secondary'}
        disabled={busy}
        onClick={() => {
          choose({ choice: 'browser' });
        }}
      >
        {m.confirm.browser}
      </Button>
      <Button
        variant="quiet"
        disabled={busy}
        onClick={() => {
          choose({ choice: 'cancel' });
        }}
      >
        {m.confirm.cancel}
      </Button>
    </>
  );
  if (state.kind === 'get') {
    const chosen = picked ?? state.passkeys[0]?.credentialId;
    return (
      <>
        <h1 className="text-title">{m.confirm.getTitle}</h1>
        <Origins state={state} app={app} />
        {state.passkeys.length === 0 ? (
          <p className="text-sm">{format(m.confirm.none, { rpId: state.rpId })}</p>
        ) : (
          <fieldset className="flex flex-col gap-1">
            <legend className="text-xs font-semibold text-muted">{m.confirm.choose}</legend>
            {state.passkeys.map((p) => (
              <Choice
                key={p.credentialId}
                name="passkey"
                checked={chosen === p.credentialId}
                onChange={() => {
                  setPicked(p.credentialId);
                }}
                title={p.title}
                detail={p.userName}
              />
            ))}
          </fieldset>
        )}
        {/* With no passkey, Confirm could do nothing: another authenticator leads (D313). */}
        {chosen === undefined ? null : (
          <Button
            variant="primary"
            disabled={busy || !armed}
            onClick={() => {
              choose({ choice: 'use', credentialId: chosen });
            }}
            data-testid="confirm-use"
          >
            {m.confirm.confirm}
          </Button>
        )}
        {others}
      </>
    );
  }
  const target = picked ?? 'new';
  return (
    <>
      <h1 className="text-title">{m.confirm.createTitle}</h1>
      <Origins state={state} app={app}>
        <Row label={m.confirm.user}>
          {state.displayName === '' || state.displayName === state.userName
            ? state.userName
            : `${state.displayName} (${state.userName})`}
        </Row>
      </Origins>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs font-semibold text-muted">{m.confirm.saveIn}</legend>
        {state.items.map((item) => (
          <Choice
            key={item.itemId}
            name="target"
            checked={target === item.itemId}
            onChange={() => {
              setPicked(item.itemId);
            }}
            title={item.title}
            detail={item.username}
          />
        ))}
        <Choice
          name="target"
          checked={target === 'new'}
          onChange={() => {
            setPicked('new');
          }}
          title={m.confirm.newItem}
          detail={state.rpName === '' ? state.rpId : state.rpName}
        />
      </fieldset>
      {state.replaces ? <Notice>{m.confirm.replaces}</Notice> : null}
      <Button
        variant="primary"
        disabled={busy || !armed}
        onClick={() => {
          choose(target === 'new' ? { choice: 'save-new' } : { choice: 'save', itemId: target });
        }}
        data-testid="confirm-save"
      >
        {m.confirm.confirm}
      </Button>
      {others}
    </>
  );
}

/**
 * The site's origin as the browser reported it, the frame's top origin, and the `rpId`; for an
 * Android app, its package in place of the site.
 */
function Origins({
  state,
  app,
  children,
}: {
  readonly state: Exclude<ConfirmState, { kind: 'locked' }>;
  readonly app?: string | undefined;
  readonly children?: ReactNode;
}) {
  const m = useMessages();
  return (
    <dl className="flex flex-col gap-2">
      {app === undefined ? (
        <Row label={m.confirm.site}>
          <span data-testid="confirm-origin">{state.origin}</span>
          {state.topOrigin === undefined ? null : (
            <span className="block text-xs text-muted">
              {format(m.confirm.frame, { origin: state.topOrigin })}
            </span>
          )}
        </Row>
      ) : (
        <Row label={m.confirm.app}>
          <span data-testid="confirm-app">{app}</span>
        </Row>
      )}
      <Row label={m.confirm.rpId}>{state.rpId}</Row>
      {children}
    </dl>
  );
}

export function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs font-semibold text-muted">{label}</dt>
      <dd className="text-sm break-all">{children}</dd>
    </div>
  );
}

function Choice({
  name,
  checked,
  onChange,
  title,
  detail,
}: {
  readonly name: string;
  readonly checked: boolean;
  readonly onChange: () => void;
  readonly title: string;
  readonly detail?: string | undefined;
}) {
  const detailId = useId();
  return (
    <label className={`${TARGET} flex items-start gap-2 rounded-control bg-raised p-2 text-sm`}>
      <input
        type="radio"
        className="mt-1"
        name={name}
        checked={checked}
        onChange={onChange}
        aria-label={title}
        aria-describedby={detail === undefined ? undefined : detailId}
      />
      <span className="flex min-w-0 flex-col">
        <span className="font-medium break-words">{title}</span>
        {detail === undefined ? null : (
          <span id={detailId} className="text-xs text-muted break-all">
            {detail}
          </span>
        )}
      </span>
    </label>
  );
}
