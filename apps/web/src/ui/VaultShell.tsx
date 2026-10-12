import { type VaultSession } from '@blindvault/vault';
import { type ReactNode, useReducer, useState, useSyncExternalStore } from 'react';

import { type VaultController } from '../app/controller';
import { type ListName, type Navigation, isDetail } from '../app/nav';
import { useMessages } from '../i18n/context';
import { Button, LockState, Notice, Phase1Banner } from './components';
import { useLayout } from './hooks';
import { hex } from './ids';
import { ItemDetail } from './ItemDetail';
import { ItemEditor } from './ItemEditor';
import { ItemList } from './ItemList';
import { Settings } from './Settings';

// One set of panes, three shells (overview §13.1, D15): the shells place the panes and hold no
// vault or security logic.

function FolderPane({ nav }: { readonly nav: Navigation }) {
  const m = useMessages();
  const list = useSyncExternalStore(nav.subscribe, nav.list);
  const entry = (name: ListName, label: string) => (
    <Button
      variant="quiet"
      className="justify-start text-left aria-[current]:bg-zinc-100 dark:aria-[current]:bg-zinc-800"
      aria-current={list === name ? 'true' : undefined}
      onClick={() => {
        nav.showList(name);
      }}
    >
      {label}
    </Button>
  );
  return (
    <nav aria-label={m.vault.folders} className="flex flex-col gap-1 p-3">
      <h2 className="px-2 text-xs font-semibold uppercase text-zinc-500">{m.vault.folders}</h2>
      {entry('vault', m.vault.allItems)}
      {entry('trash', m.vault.trash)}
    </nav>
  );
}

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
  const list = <ItemList session={session} nav={nav} />;

  let body: ReactNode;
  if (screen.name === 'settings') {
    body = <Settings controller={controller} session={session} />;
  } else if (layout === 'desktop') {
    body = (
      <div className="grid flex-1 grid-cols-[16rem_20rem_1fr] divide-x divide-zinc-200 dark:divide-zinc-800">
        <FolderPane nav={nav} />
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
          {drawer ? <FolderPane nav={nav} /> : null}
          {list}
        </div>
        {detail}
      </div>
    );
  } else if (isDetail(screen)) {
    body = detail;
  } else {
    body = (
      <div className="flex flex-1 flex-col">
        <FolderPane nav={nav} />
        {list}
      </div>
    );
  }

  return (
    <div
      data-layout={layout}
      className="flex min-h-dvh flex-col bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100"
    >
      <Phase1Banner />
      <Header controller={controller} nav={nav} mobile={layout === 'mobile'} />
      {session.writable ? null : <Notice>{m.vault.readOnlyVault}</Notice>}
      <main className="flex flex-1 flex-col">{body}</main>
      {layout === 'mobile' && !isDetail(screen) && screen.name !== 'settings' ? (
        <footer className="flex justify-around border-t border-zinc-200 p-2 dark:border-zinc-800">
          <Button
            variant="quiet"
            aria-current={screen.name === 'vault' ? 'page' : undefined}
            onClick={() => {
              nav.showList('vault');
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
