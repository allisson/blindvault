import { useEffect, useState } from 'react';

import {
  type PopupRuntime,
  type HostState,
  copy,
  lock,
  onLocked,
  openHost,
  search,
  status,
} from '../extension/popup-client';
import { type Copyable, type Found } from '../extension/rpc';
import { useMessages } from '../i18n/context';
import { format } from '../i18n/messages';
import { Button, Field, Notice } from './components';

/**
 * The extension's popup (extension.md §6, D283, D286): the vault's state, a search of the Login
 * items to copy from, Lock and Open. It never unlocks; a locked vault offers only to open the
 * session host.
 */
export function Popup({
  runtime,
  close,
}: {
  readonly runtime: PopupRuntime;
  readonly close: () => void;
}) {
  const m = useMessages();
  const [state, setState] = useState<HostState | 'checking'>('checking');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<readonly Found[]>();
  const [note, setNote] = useState<string>();

  useEffect(() => {
    // A lock clears the popup (§3.2).
    onLocked(runtime, close);
    void status(runtime).then(setState);
  }, [runtime, close]);

  useEffect(() => {
    if (state !== 'unlocked') return;
    let live = true;
    void search(runtime, query).then((result) => {
      if (!live) return;
      if (Array.isArray(result)) {
        setItems(result);
        return;
      }
      setItems(undefined);
      if (result === 'locked') setState('locked');
      else setNote(m.popup.failed);
    });
    return () => {
      live = false;
    };
  }, [runtime, state, query, m]);

  const open = () => {
    void openHost(runtime).then(close);
  };

  const copyField = (itemId: string, field: Copyable) => {
    void copy(runtime, itemId, field).then(async (result) => {
      if (typeof result !== 'object') {
        if (result === 'locked') setState('locked');
        else setNote(m.popup.failed);
        return;
      }
      try {
        await navigator.clipboard.writeText(result.value);
        setNote(format(m.popup.copied, { seconds: String(result.clearSeconds) }));
      } catch {
        setNote(m.items.copyFailed);
      }
    });
  };

  return (
    <main data-testid="popup" className="flex w-80 flex-col gap-3 bg-surface p-4 text-fg">
      <header className="flex items-center gap-2">
        <span className="text-sm font-semibold">{m.app.name}</span>
        <span className="flex-1" />
        {state === 'unlocked' ? (
          <Button
            variant="quiet"
            onClick={() => {
              void lock(runtime).then(close);
            }}
          >
            {m.app.lock}
          </Button>
        ) : null}
      </header>
      {state === 'locked' ? <p className="text-sm">{m.popup.locked}</p> : null}
      {state === 'unlocked' ? (
        <>
          <Field
            label={m.popup.search}
            type="search"
            value={query}
            // The popup opens on the user's click, to search at once.
            autoFocus
            onChange={(e) => {
              setQuery(e.target.value);
            }}
          />
          {items?.length === 0 ? <p className="text-sm text-muted">{m.popup.none}</p> : null}
          <ul data-testid="popup-items" className="flex flex-col gap-2">
            {items?.map((item) => (
              <li key={item.itemId} className="flex flex-col gap-1 rounded-control bg-raised p-2">
                <span className="text-sm font-medium break-words">{item.title}</span>
                {item.username === undefined ? null : (
                  <span className="text-xs text-muted break-all">{item.username}</span>
                )}
                <span className="flex flex-wrap gap-1">
                  {item.fields.map((field) => (
                    <Button
                      key={field}
                      variant="secondary"
                      onClick={() => {
                        copyField(item.itemId, field);
                      }}
                    >
                      {COPY_LABEL[field](m)}
                    </Button>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {note === undefined ? null : <Notice>{note}</Notice>}
      {state === 'checking' ? null : (
        <Button variant={state === 'locked' ? 'primary' : 'secondary'} onClick={open}>
          {m.popup.open}
        </Button>
      )}
    </main>
  );
}

const COPY_LABEL: Record<Copyable, (m: ReturnType<typeof useMessages>) => string> = {
  username: (m) => m.popup.copyUsername,
  password: (m) => m.popup.copyPassword,
  totp: (m) => m.popup.copyCode,
};
