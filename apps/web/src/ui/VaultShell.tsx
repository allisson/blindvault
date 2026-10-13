import { type VaultSession } from '@blindvault/vault';
import {
  type ReactNode,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { type VaultController } from '../app/controller';
import { type Navigation, isDetail } from '../app/nav';
import { SearchIndex } from '../app/search';
import { useMessages } from '../i18n/context';
import { Button, LockState, Notice, PreviewBanner, SharedOriginWarning } from './components';
import { useLayout } from './hooks';
import { hex } from '../app/ids';
import { ItemDetail } from './ItemDetail';
import { ItemEditor } from './ItemEditor';
import { ItemHistory } from './ItemHistory';
import { FolderPane } from './Folders';
import { ItemList } from './ItemList';
import { Settings } from './Settings';

// One set of panes, three shells (overview §13.1, D15): the shells place the panes and hold no
// vault or security logic.

function DetailPane({
  session,
  nav,
  onChange,
}: {
  readonly session: VaultSession;
  readonly nav: Navigation;
  readonly onChange: () => void;
}) {
  const m = useMessages();
  const screen = useSyncExternalStore(nav.subscribe, nav.current);
  if (!isDetail(screen)) {
    return (
      <section aria-label={m.vault.detail} className="flex flex-1 items-center justify-center p-4">
        <p className="text-sm text-zinc-500">{m.vault.nothingSelected}</p>
      </section>
    );
  }
  // Keyed by screen and item, so a revealed secret or a draft never carries to another item.
  const key = screen.name === 'new' ? 'new' : `${screen.name}-${hex(screen.id)}`;
  return (
    <section aria-label={m.vault.detail} className="flex flex-1 justify-center overflow-y-auto">
      {screen.name === 'item' ? (
        <ItemDetail key={key} session={session} id={screen.id} nav={nav} onChange={onChange} />
      ) : screen.name === 'history' ? (
        <ItemHistory key={key} session={session} id={screen.id} nav={nav} onChange={onChange} />
      ) : (
        <ItemEditor
          key={key}
          session={session}
          {...(screen.name === 'edit' ? { id: screen.id } : {})}
          nav={nav}
          onChange={onChange}
        />
      )}
    </section>
  );
}

function Header({
  controller,
  nav,
  mobile,
}: {
  readonly controller: VaultController;
  readonly nav: Navigation;
  /** Mobile drills down and has Settings in its bottom navigation instead. */
  readonly mobile: boolean;
}) {
  const m = useMessages();
  const screen = useSyncExternalStore(nav.subscribe, nav.current);
  const back = mobile ? screen.name !== 'vault' : screen.name === 'settings';
  return (
    <header className="flex items-center gap-2 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
      {back ? (
        <Button
          variant="quiet"
          onClick={() => {
            nav.back();
          }}
        >
          {m.app.back}
        </Button>
      ) : null}
      <span className="font-semibold">{m.app.name}</span>
      <LockState unlocked />
      <span className="flex-1" />
      {!mobile && screen.name !== 'settings' ? (
        <Button
          variant="quiet"
          onClick={() => {
            nav.open({ name: 'settings' });
          }}
        >
          {m.app.settings}
        </Button>
      ) : null}
      <Button
        onClick={() => {
          controller.lock();
        }}
        title="Ctrl/⌘ + Shift + L"
      >
        {m.app.lock}
      </Button>
    </header>
  );
}

export function VaultShell({
  controller,
  session,
  nav,
}: {
  readonly controller: VaultController;
  readonly session: VaultSession;
  readonly nav: Navigation;
}) {
  const layout = useLayout();
  const screen = useSyncExternalStore(nav.subscribe, nav.current);
  const [drawer, setDrawer] = useState(false);
  // The session holds the state; a write only asks the panes to read it again.
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const m = useMessages();
  const detail = <DetailPane session={session} nav={nav} onChange={refresh} />;
  // The search index and query live in memory only, and go with the shell on lock (D132).
  const index = useMemo(() => new SearchIndex(), []);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(
    () => () => {
      index.clear();
    },
    [index],
  );
  useEffect(() => {
    // Ctrl/⌘ + K focuses search (overview §13.1).
    const focus = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', focus);
    return () => {
      window.removeEventListener('keydown', focus);
    };
  }, []);
  const list = (
    <ItemList
      session={session}
      nav={nav}
      onChange={refresh}
      index={index}
      query={query}
      onQuery={setQuery}
      searchRef={searchRef}
    />
  );
  const folders = <FolderPane session={session} nav={nav} onChange={refresh} />;

  let body: ReactNode;
  if (screen.name === 'settings') {
    body = <Settings controller={controller} session={session} nav={nav} />;
  } else if (layout === 'desktop') {
    body = (
      <div className="grid flex-1 grid-cols-[16rem_20rem_1fr] divide-x divide-zinc-200 dark:divide-zinc-800">
        {folders}
        {list}
        {detail}
      </div>
    );
  } else if (layout === 'tablet') {
    body = (
      <div className="relative grid flex-1 grid-cols-[18rem_1fr] divide-x divide-zinc-200 dark:divide-zinc-800">
        <div className="flex flex-col">
          <Button
            variant="quiet"
            className="m-2 self-start"
            aria-expanded={drawer}
            onClick={() => {
              setDrawer(!drawer);
            }}
          >
            {m.vault.folders}
          </Button>
          {drawer ? folders : null}
          {list}
        </div>
        {detail}
      </div>
    );
  } else if (isDetail(screen)) {
    body = detail;
  } else {
    // Mobile drills down: folders and all items, then a folder or the trash, then the detail.
    body = (
      <div className="flex flex-1 flex-col">
        {screen.name === 'vault' ? folders : null}
        {list}
      </div>
    );
  }

  return (
    <div
      data-layout={layout}
      className="flex min-h-dvh flex-col bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100"
    >
      <SharedOriginWarning />
      <PreviewBanner />
      <Header controller={controller} nav={nav} mobile={layout === 'mobile'} />
      {session.writable ? null : <Notice>{m.vault.readOnlyVault}</Notice>}
      {session.retired ? (
        <div className="px-4 py-2" data-testid="own-retired">
          <Notice>{m.merge.ownRetired}</Notice>
        </div>
      ) : null}
      {controller.afterRestore === 'check-phrase' ? (
        <div className="flex flex-wrap items-center gap-2 px-4 py-2" data-testid="after-restore">
          <Notice>{m.restore.checkPhrase}</Notice>
          <Button
            variant="quiet"
            onClick={() => {
              controller.dismissAfterRestore();
            }}
          >
            {m.restore.dismiss}
          </Button>
        </div>
      ) : null}
      {controller.afterRefounding ? (
        <div className="flex flex-wrap items-center gap-2 px-4 py-2" data-testid="refounded">
          <Notice>{m.refound.done}</Notice>
          <Button
            variant="quiet"
            onClick={() => {
              controller.dismissRefounded();
              nav.open({ name: 'settings' });
            }}
          >
            {m.restore.openSettings}
          </Button>
          <Button
            variant="quiet"
            onClick={() => {
              controller.dismissRefounded();
            }}
          >
            {m.restore.dismiss}
          </Button>
        </div>
      ) : null}
      {controller.readmissionNotice ? (
        <div className="flex flex-wrap items-center gap-2 px-4 py-2" data-testid="readmission">
          <Notice>{m.restore.readmit}</Notice>
          <Button
            variant="quiet"
            onClick={() => {
              controller.dismissReadmission();
              nav.open({ name: 'settings' });
            }}
          >
            {m.restore.openSettings}
          </Button>
          <Button
            variant="quiet"
            onClick={() => {
              controller.dismissReadmission();
            }}
          >
            {m.restore.dismiss}
          </Button>
        </div>
      ) : null}
      {controller.leftoverPasskey ? (
        <div className="flex flex-wrap items-center gap-2 px-4 py-2" data-testid="leftover-passkey">
          <Notice>{m.replace.leftoverPasskey}</Notice>
          <Button
            variant="quiet"
            onClick={() => {
              controller.dismissLeftoverPasskey();
            }}
          >
            {m.restore.dismiss}
          </Button>
        </div>
      ) : null}
      <main className="flex flex-1 flex-col">{body}</main>
      {layout === 'mobile' && !isDetail(screen) && screen.name !== 'settings' ? (
        <footer className="flex justify-around border-t border-zinc-200 p-2 dark:border-zinc-800">
          <Button
            variant="quiet"
            aria-current={screen.name === 'vault' ? 'page' : undefined}
            onClick={() => {
              nav.showList({ name: 'vault' });
            }}
          >
            {m.vault.items}
          </Button>
          <Button
            variant="quiet"
            onClick={() => {
              nav.open({ name: 'settings' });
            }}
          >
            {m.app.settings}
          </Button>
        </footer>
      ) : null}
    </div>
  );
}
