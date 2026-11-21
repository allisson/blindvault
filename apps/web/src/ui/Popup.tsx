import { type ReactNode, useEffect, useRef, useState } from 'react';

import {
  type PopupRuntime,
  type HostState,
  copy,
  fill,
  lock,
  matches,
  onLocked,
  openHost,
  search,
  status,
} from '../extension/popup-client';
import { type Copyable, type Found, type Matched, type Refusal } from '../extension/rpc';
import { useMessages } from '../i18n/context';
import { format } from '../i18n/messages';
import { Button, Field, Notice } from './components';

/**
 * The extension's popup (extension.md §6, D283, D286, D287): the vault's state, the Login items that
 * match the tab's page to fill or copy from, a search of every Login item to copy from, Lock and
 * Open. It never unlocks; a locked vault offers only to open the session host.
 */
export function Popup({
  runtime,
  tab,
  close,
}: {
  readonly runtime: PopupRuntime;
  /** The tab the popup was opened over. */
  readonly tab: () => Promise<number | undefined>;
  readonly close: () => void;
}) {
  const m = useMessages();
  const [state, setState] = useState<HostState | 'checking'>('checking');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<readonly Found[]>();
  const [tabId, setTabId] = useState<number>();
  const [matched, setMatched] = useState<readonly Matched[] | 'page'>();
  const [note, setNote] = useState<string>();
  const main = useRef<HTMLElement>(null);

  const refusedNote = (refusal: Refusal | undefined): string => {
    switch (refusal) {
      case 'page':
        return m.popup.noPage;
      case 'no-match':
        return m.popup.noMatch;
      case 'no-target':
        return m.popup.noTarget;
      case 'moved':
        return m.popup.moved;
      default:
        return m.popup.failed;
    }
  };

  useEffect(() => {
    // A lock clears the popup (§3.2).
    onLocked(runtime, close);
    void status(runtime).then(setState);
  }, [runtime, close]);

  useEffect(() => {
    // The popup opens on the user's click, to search at once. Without scrolling: Firefox focuses
    // while its popup is still short, and would open it scrolled past the header.
    if (state === 'unlocked') {
      main.current?.querySelector('input')?.focus({ preventScroll: true });
    }
  }, [state]);

  useEffect(() => {
    if (state !== 'unlocked') return;
    let live = true;
    void tab().then(async (id) => {
      const result = id === undefined ? 'page' : await matches(runtime, id);
      if (!live) return;
      setTabId(id);
      if (Array.isArray(result) || result === 'page') setMatched(result);
      else if (result === 'locked') setState('locked');
      else setNote(m.popup.failed);
    });
    return () => {
      live = false;
    };
  }, [runtime, tab, state, m]);

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

  const fillItem = (itemId: string) => {
    if (tabId === undefined) return;
    void fill(runtime, tabId, itemId).then((result) => {
      if (result === true) {
        close();
        return;
      }
      if (result === 'locked') setState('locked');
      else setNote(refusedNote(result));
    });
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
    <main
      ref={main}
      data-testid="popup"
      className="flex w-80 flex-col gap-3 bg-surface p-4 text-fg"
    >
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
            onChange={(e) => {
              setQuery(e.target.value);
            }}
          />
          {query === '' ? (
            <section className="flex flex-col gap-2">
              <h2 className="text-xs font-semibold text-muted">{m.popup.onPage}</h2>
              {matched === 'page' ? <p className="text-sm text-muted">{m.popup.noPage}</p> : null}
              {matched !== undefined && matched !== 'page' && matched.length === 0 ? (
                <p className="text-sm text-muted">{m.popup.noMatch}</p>
              ) : null}
              <ul data-testid="popup-matches" className="flex flex-col gap-2">
                {matched !== undefined && matched !== 'page'
                  ? matched.map((item) => (
                      <Row key={item.itemId} item={item} url={item.url}>
                        {item.fields.some((f) => f !== 'totp') ? (
                          <Button
                            variant="primary"
                            onClick={() => {
                              fillItem(item.itemId);
                            }}
                          >
                            {m.popup.fill}
                          </Button>
                        ) : null}
                        <CopyButtons item={item} copyField={copyField} />
                      </Row>
                    ))
                  : null}
              </ul>
            </section>
          ) : null}
          {items?.length === 0 ? <p className="text-sm text-muted">{m.popup.none}</p> : null}
          <ul data-testid="popup-items" className="flex flex-col gap-2">
            {items?.map((item) => (
              <Row key={item.itemId} item={item}>
                <CopyButtons item={item} copyField={copyField} />
              </Row>
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

/** One Login item of a list: its title, user name and, for a match, the URL that matched. */
function Row({
  item,
  url,
  children,
}: {
  readonly item: Found;
  readonly url?: string;
  readonly children: ReactNode;
}) {
  return (
    <li className="flex flex-col gap-1 rounded-control bg-raised p-2">
      <span className="text-sm font-medium break-words">{item.title}</span>
      {item.username === undefined ? null : (
        <span className="text-xs text-muted break-all">{item.username}</span>
      )}
      {url === undefined ? null : <span className="text-xs text-muted break-all">{url}</span>}
      <span className="flex flex-wrap gap-1">{children}</span>
    </li>
  );
}

function CopyButtons({
  item,
  copyField,
}: {
  readonly item: Found;
  readonly copyField: (itemId: string, field: Copyable) => void;
}) {
  const m = useMessages();
  return item.fields.map((field) => (
    <Button
      key={field}
      variant="secondary"
      onClick={() => {
        copyField(item.itemId, field);
      }}
    >
      {COPY_LABEL[field](m)}
    </Button>
  ));
}

const COPY_LABEL: Record<Copyable, (m: ReturnType<typeof useMessages>) => string> = {
  username: (m) => m.popup.copyUsername,
  password: (m) => m.popup.copyPassword,
  totp: (m) => m.popup.copyCode,
};
