import { type VaultSession } from '@blindvault/vault';
import { useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';

import { type BackupReminder } from '../app/backup-reminder';
import { type VaultController } from '../app/controller';
import { type Navigation, isDetail } from '../app/nav';
import { SearchIndex } from '../app/search';
import { newItemShortcut } from '../app/shortcuts';
import { useLanguage, useMessages } from '../i18n/context';
import { type Messages, format } from '../i18n/messages';
import {
  Button,
  LockState,
  Notice,
  PreviewBanner,
  SharedOriginWarning,
  UpdateBanner,
} from './components';
import { useLayout } from './hooks';
import { hex } from '../app/ids';
import { ItemDetail } from './ItemDetail';
import { ItemEditor } from './ItemEditor';
import { ItemHistory } from './ItemHistory';
import { FolderPane } from './Folders';
import { ItemList } from './ItemList';
import { Ready } from './Ready';
import { focusBackup } from './RegeneratePhrase';
import { Settings } from './Settings';
import { StorageWarningBanner } from './StorageState';

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
  // Keyed by screen and item, so a revealed secret or a draft never carries to another item, and
  // by opening for a new item, so each New item starts from the template picker (D210).
  const key =
    screen.name === 'new'
      ? `new-${String(nav.opening(screen))}`
      : `${screen.name}-${hex(screen.id)}`;
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
        aria-keyshortcuts="Control+Shift+L Meta+Shift+L"
      >
        {m.app.lock}
      </Button>
    </header>
  );
}

/** The live sync session, wherever the user is in the vault (sync-protocol.md §10, D225). */
function LiveSync({
  controller,
  nav,
}: {
  readonly controller: VaultController;
  readonly nav: Navigation;
}) {
  const m = useMessages();
  const stage = useSyncExternalStore(controller.subscribe, () => controller.sync);
  const peer = useSyncExternalStore(controller.subscribe, () => controller.syncPeer);
  if (stage?.kind !== 'synced' || !stage.live || !peer) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-4 py-2 text-sm dark:border-zinc-800"
      data-testid="live-sync"
    >
      <p role="status">{format(m.sync.live, { name: peer.name })}</p>
      {stage.unseen ? <Notice>{m.sync.liveNotices}</Notice> : null}
      <span className="flex-1" />
      <Button
        variant="quiet"
        onClick={() => {
          nav.open({ name: 'settings', focus: 'devices' });
        }}
        data-testid="live-sync-show"
      >
        {m.sync.liveShow}
      </Button>
      <Button
        variant="quiet"
        onClick={() => {
          controller.cancelSync();
        }}
        data-testid="live-sync-end"
      >
        {m.sync.liveEnd}
      </Button>
    </div>
  );
}

/** A text field types the key instead of taking it as a shortcut. */
function editable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT')
  );
}

/** What the backup reminder says (§13.4, D188). */
function reminderText(m: Messages, language: string, reminder: BackupReminder): string {
  switch (reminder.kind) {
    case 'never':
      return m.vault.reminderNever;
    case 'old-phrase':
      return m.vault.reminderOldPhrase;
    case 'stale':
      return format(m.vault.reminderStale, {
        date: new Intl.DateTimeFormat(language, { dateStyle: 'long' }).format(reminder.at),
      });
  }
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
  const { messages: m, language } = useLanguage();
  // "Vault ready" lists the backup, so the reminder waits until it is closed (D198).
  const ready = controller.ready;
  const reminder = ready ? undefined : controller.backupReminder;
  const clock = controller.clockNotice;
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
    // Ctrl/⌘ + K focuses search; N alone starts a new item (overview §13.1, D197).
    const keys = (e: KeyboardEvent) => {
      // Under "Vault ready" a new item would open unseen (D198).
      if (e.defaultPrevented || controller.ready) return;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (
        newItemShortcut(e, {
          editing: editable(e.target),
          screen: nav.current(),
          list: nav.list(),
          writable: session.writable,
        })
      ) {
        e.preventDefault();
        nav.select({ name: 'new' });
      }
    };
    window.addEventListener('keydown', keys);
    return () => {
      window.removeEventListener('keydown', keys);
    };
  }, [controller, nav, session]);
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

  // The tablet drawer closes on any navigation, and when the layout is no longer tablet (D197).
  const tablet = layout === 'tablet';
  useEffect(() => {
    setDrawer(false);
  }, [screen, layout]);
  const open = tablet && drawer;
  const toggleRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    // Opening moves the focus into the drawer; closing returns it to its button.
    if (open) drawerRef.current?.querySelector('button')?.focus();
    else if (wasOpen.current) toggleRef.current?.focus();
    wasOpen.current = open;
  }, [open]);
  useEffect(() => {
    if (!open) return;
    // Escape closes the drawer and nothing else.
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawer(false);
    };
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('keydown', escape);
    };
  }, [open]);

  // One tree for every layout, so a resize remounts nothing (D197): each pane keeps its place and
  // the layout only styles or hides it. Settings hides the panes without unmounting them.
  const settings = screen.name === 'settings';
  const detailShown = isDetail(screen);
  // Mobile drills down: folders and all items, then a folder or the trash, then the detail.
  const shown = {
    folders: layout === 'desktop' || open || (layout === 'mobile' && screen.name === 'vault'),
    list: layout !== 'mobile' || !detailShown,
    detail: layout !== 'mobile' || detailShown,
  };
  const panes = {
    desktop: 'grid grid-cols-[16rem_20rem_1fr]',
    tablet: 'relative grid grid-cols-[18rem_1fr]',
    mobile: 'flex flex-col',
  }[layout];
  const folderPlace = {
    desktop: 'border-r border-zinc-200 dark:border-zinc-800',
    tablet:
      'absolute inset-y-0 left-0 z-20 w-72 overflow-y-auto border-r border-zinc-200 bg-white shadow-lg dark:border-zinc-800 dark:bg-zinc-950',
    mobile: '',
  }[layout];
  const listPlace =
    layout === 'mobile' ? 'flex-1' : 'border-r border-zinc-200 dark:border-zinc-800';
  const body = (
    <>
      {ready && !settings ? (
        <Ready controller={controller} session={session} nav={nav} ready={ready} />
      ) : null}
      <div className={`flex-1 ${panes} ${settings || ready ? 'hidden' : ''}`} data-testid="panes">
        {open ? (
          // Escape and the button close it too: the backdrop is for the pointer only.
          <div
            aria-hidden="true"
            data-testid="drawer-backdrop"
            className="absolute inset-0 z-10 bg-zinc-950/30"
            onClick={() => {
              setDrawer(false);
            }}
          />
        ) : null}
        <div
          ref={drawerRef}
          id="folder-drawer"
          className={`${folderPlace} ${shown.folders ? '' : 'hidden'}`}
        >
          {folders}
        </div>
        <div className={`flex min-w-0 flex-col ${listPlace} ${shown.list ? '' : 'hidden'}`}>
          {tablet ? (
            <Button
              ref={toggleRef}
              variant="quiet"
              className="m-2 self-start"
              aria-expanded={drawer}
              aria-controls="folder-drawer"
              onClick={() => {
                setDrawer(!drawer);
              }}
            >
              {m.vault.folders}
            </Button>
          ) : null}
          {list}
        </div>
        <div className={`flex min-w-0 flex-1 ${shown.detail ? '' : 'hidden'}`}>{detail}</div>
      </div>
      {settings ? (
        <Settings controller={controller} session={session} nav={nav} focus={screen.focus} />
      ) : null}
    </>
  );

  return (
    <div
      data-layout={layout}
      className="flex min-h-dvh flex-col bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100"
    >
      <SharedOriginWarning />
      <PreviewBanner />
      <UpdateBanner />
      <Header controller={controller} nav={nav} mobile={layout === 'mobile'} />
      <LiveSync controller={controller} nav={nav} />
      <StorageWarningBanner controller={controller} session={session} />
      {clock ? (
        <div className="flex flex-wrap items-center gap-2 px-4 py-2" data-testid="clock-behind">
          <Notice>
            {format(m.vault.clockBehind, {
              date: new Intl.DateTimeFormat(language, {
                dateStyle: 'long',
                timeStyle: 'short',
              }).format(clock.until),
            })}
          </Notice>
          {clock.far ? (
            <>
              <Notice>{m.vault.clockFar}</Notice>
              <Button
                variant="quiet"
                data-testid="clock-refound"
                onClick={() => {
                  nav.open({ name: 'settings', focus: 'refound' });
                }}
              >
                {m.refound.title}
              </Button>
              {clock.pairAgain ? <Notice>{m.vault.clockPairAgain}</Notice> : null}
            </>
          ) : null}
        </div>
      ) : null}
      {session.retired ? (
        <div className="px-4 py-2" data-testid="own-retired">
          <Notice>{m.merge.ownRetired}</Notice>
        </div>
      ) : null}
      {controller.afterRestore === 'check-phrase' && !ready ? (
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
      {reminder ? (
        <div className="flex flex-wrap items-center gap-2 px-4 py-2" data-testid="backup-reminder">
          <Notice>{reminderText(m, language, reminder)}</Notice>
          <Button
            variant="quiet"
            onClick={() => {
              if (screen.name === 'settings') focusBackup();
              else nav.open({ name: 'settings', focus: 'backup' });
            }}
          >
            {m.vault.reminderBackup}
          </Button>
          <Button
            variant="quiet"
            onClick={() => {
              controller.dismissBackupReminder();
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
