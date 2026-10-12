import { type VaultSession } from '@blindvault/vault';
import { type ReactNode, useState, useSyncExternalStore } from 'react';

import { type VaultController } from '../app/controller';
import { type Navigation } from '../app/nav';
import { useMessages } from '../i18n/context';
import { Button, LockState, Phase1Banner } from './components';
import { useLayout } from './hooks';
import { Settings } from './Settings';

// One set of panes, three shells (overview §13.1, D15): the shells place the panes and hold no
// vault or security logic.

function FolderPane() {
  const m = useMessages();
  return (
    <nav aria-label={m.vault.folders} className="flex flex-col gap-1 p-3">
      <h2 className="px-2 text-xs font-semibold uppercase text-zinc-500">{m.vault.folders}</h2>
      <span className="rounded-md bg-zinc-100 px-2 py-1.5 text-sm dark:bg-zinc-800">
        {m.vault.allItems}
      </span>
    </nav>
  );
}

function ItemListPane() {
  const m = useMessages();
  return (
    <section aria-label={m.vault.items} className="flex flex-col gap-2 p-4">
      <h2 className="text-sm font-semibold">{m.vault.items}</h2>
      <p className="text-sm text-zinc-500">{m.vault.empty}</p>
    </section>
  );
}

function DetailPane() {
  const m = useMessages();
  return (
    <section aria-label={m.vault.detail} className="flex flex-1 items-center justify-center p-4">
      <p className="text-sm text-zinc-500">{m.vault.nothingSelected}</p>
    </section>
  );
}

function Header({
  controller,
  nav,
  settings,
}: {
  readonly controller: VaultController;
  readonly nav: Navigation;
  /** Mobile has Settings in its bottom navigation instead. */
  readonly settings: boolean;
}) {
  const m = useMessages();
  const screen = useSyncExternalStore(nav.subscribe, nav.current);
  return (
    <header className="flex items-center gap-2 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
      {screen.name !== 'vault' ? (
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
      {settings && screen.name === 'vault' ? (
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
  const m = useMessages();

  let body: ReactNode;
  if (screen.name === 'settings') {
    body = <Settings controller={controller} session={session} />;
  } else if (layout === 'desktop') {
    body = (
      <div className="grid flex-1 grid-cols-[16rem_20rem_1fr] divide-x divide-zinc-200 dark:divide-zinc-800">
        <FolderPane />
        <ItemListPane />
        <DetailPane />
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
          {drawer ? <FolderPane /> : null}
          <ItemListPane />
        </div>
        <DetailPane />
      </div>
    );
  } else {
    body = (
      <div className="flex flex-1 flex-col">
        <FolderPane />
        <ItemListPane />
      </div>
    );
  }

  return (
    <div
      data-layout={layout}
      className="flex min-h-dvh flex-col bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100"
    >
      <Phase1Banner />
      <Header controller={controller} nav={nav} settings={layout !== 'mobile'} />
      <main className="flex flex-1 flex-col">{body}</main>
      {layout === 'mobile' && screen.name === 'vault' ? (
        <footer className="flex justify-around border-t border-zinc-200 p-2 dark:border-zinc-800">
          <Button variant="quiet" aria-current="page">
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
