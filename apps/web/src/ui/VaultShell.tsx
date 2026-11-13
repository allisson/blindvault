import { type VaultSession } from '@blindvault/vault';
import { useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';

import { type BackupReminder } from '../app/backup-reminder';
import { type VaultController } from '../app/controller';
import { type Navigation, isDetail, isList } from '../app/nav';
import { SearchIndex } from '../app/search';
import { newItemShortcut } from '../app/shortcuts';
import { useLanguage, useMessages } from '../i18n/context';
import { type Messages, format } from '../i18n/messages';
import {
  Button,
  LockState,
  Notice,
  Overflow,
  PreviewBadge,
  SharedOriginWarning,
  TARGET,
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
import { Settings } from './Settings';
import { StorageWarningBanner } from './StorageState';
import { Icon } from './icons';
import { ToastRegion } from './Toast';

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
  // On a phone the whole screen scrolls, so the editor's bar sticks to it (D254).
  const scrolls = useLayout() !== 'mobile';
  const screen = useSyncExternalStore(nav.subscribe, nav.current);
  if (!isDetail(screen)) {
    return (
      <section aria-label={m.vault.detail} className="flex flex-1 items-center justify-center p-4">
        <p className="text-sm text-muted">{m.vault.nothingSelected}</p>
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
    <section
      aria-label={m.vault.detail}
      className={`flex min-w-0 flex-1 justify-center ${scrolls ? 'overflow-y-auto' : ''}`}
    >
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
  session,
  nav,
  mobile,
}: {
  readonly controller: VaultController;
  readonly session: VaultSession;
  readonly nav: Navigation;
  /**
   * Mobile drills down, has Settings in its bottom navigation instead, New item as the header's
   * action and Lock in the "…" menu (D245).
   */
  readonly mobile: boolean;
}) {
  const m = useMessages();
  const screen = useSyncExternalStore(nav.subscribe, nav.current);
  const back = mobile ? screen.name !== 'vault' : screen.name === 'settings';
  const lock = {
    onClick: () => {
      controller.lock();
    },
    title: 'Ctrl/⌘ + Shift + L',
    'aria-keyshortcuts': 'Control+Shift+L Meta+Shift+L',
    children: (
      <>
        <Icon name="lock" className="me-1.5" />
        {m.app.lock}
      </>
    ),
  };
  // Under "Vault ready" a new item would open unseen (D198).
  const adds = isList(screen) && screen.name !== 'trash' && session.writable && !controller.ready;
  return (
    <header
      className={`flex items-center border-b border-line py-2 ${mobile ? 'gap-1 px-3' : 'gap-2 px-4'}`}
    >
      {back ? (
        <Button
          variant="quiet"
          className="ps-2"
          onClick={() => {
            nav.back();
          }}
        >
          <Icon name="chevron-left" className="me-1" />
          {m.app.back}
        </Button>
      ) : null}
      {/* A phone's drill-down keeps Back and the lock state only (D254). */}
      {mobile && back ? null : (
        <>
          <span className="min-w-0 truncate font-semibold">{m.app.name}</span>
          <PreviewBadge />
        </>
      )}
      <LockState unlocked className="ms-auto shrink-0 whitespace-nowrap" />
      {!mobile && screen.name !== 'settings' ? (
        <Button
          variant="quiet"
          onClick={() => {
            nav.open({ name: 'settings' });
          }}
        >
          <Icon name="settings" className="me-1.5" />
          {m.app.settings}
        </Button>
      ) : null}
      {mobile ? (
        <>
          {adds ? (
            <Button
              className="px-3.5"
              aria-label={m.items.new}
              title={`${m.items.new} (N)`}
              aria-keyshortcuts="N"
              onClick={() => {
                nav.select({ name: 'new' });
              }}
            >
              <Icon name="plus" />
            </Button>
          ) : null}
          <Overflow label={m.app.more} className="px-3.5">
            <Button variant="quiet" className="text-left" {...lock} />
          </Overflow>
        </>
      ) : (
        <Button variant="secondary" {...lock} />
      )}
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
      className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2 text-sm"
      data-testid="live-sync"
    >
      <p role="status">{format(m.sync.live, { name: peer.name })}</p>
      {stage.unseen ? <Notice>{m.sync.liveNotices}</Notice> : null}
      <span className="flex-1" />
      <Button
        variant="quiet"
        onClick={() => {
          nav.openSettings('devices');
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
  // At the top of the item list, with its two actions (§13.4, D188, D254).
  const backupReminder = reminder ? (
    <div
      role="note"
      className="grid grid-cols-[1fr_auto] items-start gap-2 rounded-card bg-info-soft px-3 py-2.5 text-sm text-info-text"
      data-testid="backup-reminder"
    >
      <p>{reminderText(m, language, reminder)}</p>
      <button
        type="button"
        className={`${TARGET} -me-1 -mt-1 min-w-10 rounded-control hover:bg-subtle`}
        aria-label={m.restore.dismiss}
        title={m.restore.dismiss}
        onClick={() => {
          controller.dismissBackupReminder();
        }}
      >
        <Icon name="x" />
      </button>
      <button
        type="button"
        className={`${TARGET} col-span-2 justify-self-start rounded-control border border-current px-3 font-medium hover:bg-subtle`}
        onClick={() => {
          nav.openSettings('backup');
        }}
      >
        <Icon name="upload" className="me-1.5" />
        {m.vault.reminderBackup}
      </button>
    </div>
  ) : null;
  const list = (
    <ItemList
      notice={backupReminder}
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
  // Mobile drills down: a list, then the detail; its folders are the list's pill (D254).
  const shown = {
    folders: layout === 'desktop' || open,
    list: layout !== 'mobile' || !detailShown,
    detail: layout !== 'mobile' || detailShown,
  };
  // Tablet and desktop: the panes fill the frame and each scrolls on its own. Mobile: one pane at
  // a time, scrolled with the notices between the header and the bottom navigation.
  const fill = layout !== 'mobile' && !settings && !ready;
  const panes = {
    desktop: 'grid min-h-0 grid-cols-[16rem_20rem_1fr] grid-rows-[minmax(0,1fr)]',
    tablet: 'relative grid min-h-0 grid-cols-[18rem_1fr] grid-rows-[minmax(0,1fr)]',
    mobile: 'flex flex-col',
  }[layout];
  const folderPlace = {
    desktop: 'overflow-y-auto border-r border-line',
    tablet:
      'absolute inset-y-0 left-0 z-20 w-72 overflow-y-auto border-r border-line bg-raised shadow-raised',
    mobile: '',
  }[layout];
  const listPlace = layout === 'mobile' ? 'flex-1' : 'min-h-0 border-r border-line';
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
            className="absolute inset-0 z-10 bg-scrim"
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
          {/* The tablet's Folders button stays above the list, which scrolls under it. On mobile the
              whole screen scrolls, so the list's sticky top sticks to it. */}
          <div className={`min-h-0 flex-1 ${layout === 'mobile' ? '' : 'overflow-y-auto'}`}>
            {list}
          </div>
        </div>
        <div className={`flex min-w-0 flex-1 ${shown.detail ? '' : 'hidden'}`}>{detail}</div>
      </div>
      {settings ? (
        <Settings
          controller={controller}
          session={session}
          nav={nav}
          page={screen.page}
          focus={screen.focus}
        />
      ) : null}
    </>
  );

  return (
    <ToastRegion>
      <div data-layout={layout} className="flex h-dvh flex-col overflow-hidden bg-surface text-fg">
        <Header controller={controller} session={session} nav={nav} mobile={layout === 'mobile'} />
        <LiveSync controller={controller} nav={nav} />
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="scroller">
          <SharedOriginWarning />
          <UpdateBanner />
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
                      nav.openSettings('refound');
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
            <div
              className="flex flex-wrap items-center gap-2 px-4 py-2"
              data-testid="after-restore"
            >
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
          {controller.leftoverPasskey ? (
            <div
              className="flex flex-wrap items-center gap-2 px-4 py-2"
              data-testid="leftover-passkey"
            >
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
          <main className={`flex flex-col ${fill ? 'min-h-0 flex-1' : 'shrink-0'}`}>{body}</main>
        </div>
        {layout === 'mobile' && !isDetail(screen) && screen.name !== 'settings' ? (
          <footer className="grid grid-cols-3 gap-1 border-t border-line p-1">
            {(
              [
                [
                  'list',
                  m.vault.items,
                  screen.name === 'vault' || screen.name === 'folder',
                  () => {
                    nav.showList({ name: 'vault' });
                  },
                ],
                [
                  'trash-2',
                  m.vault.trash,
                  screen.name === 'trash',
                  () => {
                    nav.showList({ name: 'trash' });
                  },
                ],
                [
                  'settings',
                  m.app.settings,
                  false,
                  () => {
                    nav.open({ name: 'settings' });
                  },
                ],
              ] as const
            ).map(([icon, label, current, go]) => (
              <Button
                key={icon}
                variant="quiet"
                className="flex flex-col items-center justify-center gap-0.5 px-1 text-xs aria-[current]:text-accent-text"
                aria-current={current ? 'page' : undefined}
                onClick={go}
              >
                <Icon name={icon} />
                {label}
              </Button>
            ))}
          </footer>
        ) : null}
      </div>
    </ToastRegion>
  );
}
