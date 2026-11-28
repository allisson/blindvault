import { type VaultSession } from '@blindvault/vault';
import {
  type ComponentProps,
  type RefObject,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { type VaultController } from '../app/controller';
import { type Navigation, type Screen, isDetail, isList, isMain } from '../app/nav';
import { SearchIndex } from '../app/search';
import { newItemShortcut } from '../app/shortcuts';
import { useMessages } from '../i18n/context';
import {
  Button,
  LockState,
  SharedOriginWarning,
  UpdateDialog,
  UpdateEntry,
  WizardPlace,
} from './components';
import { useLayout } from './hooks';
import { hex } from '../app/ids';
import { ItemDetail } from './ItemDetail';
import { ItemEditor } from './ItemEditor';
import { ItemHistory } from './ItemHistory';
import { ItemList } from './ItemList';
import { NoticesScreen, StatusLine, StatusPill } from './Notices';
import { Ready } from './Ready';
import { DevicesScreen, Settings } from './Settings';
import { Brand, Sidebar } from './Sidebar';
import { useStorageRefresh } from './StorageState';
import { Icon } from './icons';
import { ToastRegion } from './Toast';

// One set of panes, three shells (overview §13.1, D15, D316): the shells place the panes, the
// sidebar, the headers and the bottom bar, and hold no vault or security logic.

function DetailPane({
  controller,
  session,
  nav,
  onChange,
}: {
  readonly controller: VaultController;
  readonly session: VaultSession;
  readonly nav: Navigation;
  readonly onChange: () => void;
}) {
  const m = useMessages();
  // An attachment waiting for its blob checks again each time a sync writes one (attachments.md §7).
  const blobWrites = useSyncExternalStore(controller.subscribe, () => controller.syncBlobs);
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
        <ItemDetail
          key={key}
          session={session}
          id={screen.id}
          nav={nav}
          onChange={onChange}
          blobWrites={blobWrites}
        />
      ) : screen.name === 'history' ? (
        <ItemHistory
          key={key}
          session={session}
          id={screen.id}
          nav={nav}
          onChange={onChange}
          blobWrites={blobWrites}
        />
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

/** Shows a phone's bottom bar: on the lists, Devices and the Settings index (D316). */
function tabbed(screen: Screen): boolean {
  return (
    isList(screen) || screen.name === 'devices' || (screen.name === 'settings' && !screen.page)
  );
}

/**
 * The header of a tablet and a phone; a desktop has the sidebar instead (D316). A tablet opens the
 * sidebar from Menu and shows the notices or the live sync as a pill. A phone drills down: Back on
 * a detail, a Settings page and Notices, with the lock state, a wizard's Cancel, New item on a list
 * and Lock always there (D245, D254).
 */
function Header({
  controller,
  session,
  nav,
  mobile,
  wizard,
  lock,
  menu,
}: {
  readonly controller: VaultController;
  readonly session: VaultSession;
  readonly nav: Navigation;
  readonly mobile: boolean;
  /** Where a wizard's Cancel goes on a phone (D254). */
  readonly wizard: (element: HTMLElement | null) => void;
  readonly lock: ComponentProps<'button'>;
  /** A tablet's Menu, which opens the sidebar's drawer. */
  readonly menu: ComponentProps<'button'> & { readonly ref: RefObject<HTMLButtonElement | null> };
}) {
  const m = useMessages();
  const screen = useSyncExternalStore(nav.subscribe, nav.current);
  const back = mobile
    ? isDetail(screen) || screen.name === 'notices' || (screen.name === 'settings' && !!screen.page)
    : isMain(screen);
  // Under "Vault ready" a new item would open unseen (D198).
  const adds = isList(screen) && screen.name !== 'trash' && session.writable && !controller.ready;
  const lockButton = (
    <Button variant="secondary" className="flex shrink-0 items-center" {...lock}>
      <Icon name="lock" className="me-2" />
      {m.app.lock}
    </Button>
  );
  return (
    <header
      className={`flex items-center border-b border-line py-2 ${mobile ? 'gap-1 px-3' : 'gap-2 px-4'}`}
    >
      {mobile ? null : (
        <Button variant="secondary" className="flex shrink-0 items-center" {...menu}>
          <Icon name="menu" className="me-2" />
          {m.shell.menu}
        </Button>
      )}
      {back ? (
        <Button
          variant="quiet"
          className="shrink-0 ps-2"
          onClick={() => {
            nav.back();
          }}
        >
          <Icon name="chevron-left" className="me-1" />
          {m.app.back}
        </Button>
      ) : null}
      {/* A phone's drill-down keeps Back and the lock state only (D254). */}
      {mobile && back ? null : <Brand compact={mobile} />}
      <span className="flex-1" />
      {mobile ? null : <StatusPill controller={controller} session={session} nav={nav} />}
      <LockState unlocked compact={mobile} className="shrink-0 whitespace-nowrap" />
      {mobile ? <span ref={wizard} className="contents" /> : null}
      {mobile && adds ? (
        <Button
          className="shrink-0 px-4"
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
      {lockButton}
    </header>
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
  useStorageRefresh(controller);
  // "Vault ready" stands in for the panes until it is closed (D198).
  const ready = controller.ready;
  const detail = (
    <DetailPane controller={controller} session={session} nav={nav} onChange={refresh} />
  );
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
  const lock: ComponentProps<'button'> = {
    onClick: () => {
      controller.lock();
    },
    title: 'Ctrl/⌘ + Shift + L',
    'aria-keyshortcuts': 'Control+Shift+L Meta+Shift+L',
  };

  // The tablet drawer closes on any navigation, and when the layout is no longer tablet (D197).
  const tablet = layout === 'tablet';
  const mobile = layout === 'mobile';
  const [wizardHeader, setWizardHeader] = useState<HTMLElement | null>(null);
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
  // the layout only styles or hides it. A main destination hides the panes without unmounting them.
  const main = isMain(screen);
  const detailShown = isDetail(screen);
  // Mobile drills down: a list, then the detail; its folders are the list's pill (D254).
  const shown = {
    list: !mobile || !detailShown,
    detail: !mobile || detailShown,
  };
  // Tablet and desktop: the panes fill the frame and each scrolls on its own. Mobile: one pane at
  // a time, scrolled with the status line between the header and the bottom bar.
  const fill = !mobile && (main || !ready);
  const panes = {
    desktop: 'grid min-h-0 grid-cols-[22rem_1fr] grid-rows-[minmax(0,1fr)]',
    tablet: 'grid min-h-0 grid-cols-[18rem_1fr] grid-rows-[minmax(0,1fr)]',
    mobile: 'flex flex-col',
  }[layout];
  const listPlace = mobile ? 'flex-1' : 'min-h-0 border-r border-line';
  // Devices and Notices: centered, scrolling on their own beside the sidebar.
  const place = mobile
    ? 'flex justify-center'
    : 'flex min-h-0 flex-1 justify-center overflow-y-auto';
  const body = (
    <>
      {ready && !main ? (
        <Ready controller={controller} session={session} nav={nav} ready={ready} />
      ) : null}
      <div className={`flex-1 ${panes} ${main || ready ? 'hidden' : ''}`} data-testid="panes">
        <div className={`flex min-w-0 flex-col ${listPlace} ${shown.list ? '' : 'hidden'}`}>
          {/* On mobile the whole screen scrolls, so the list's sticky top sticks to it. */}
          <div className={`min-h-0 flex-1 ${mobile ? '' : 'overflow-y-auto'}`}>{list}</div>
        </div>
        <div className={`flex min-w-0 flex-1 ${shown.detail ? '' : 'hidden'}`}>{detail}</div>
      </div>
      {screen.name === 'settings' ? (
        <Settings
          controller={controller}
          session={session}
          nav={nav}
          page={screen.page}
          focus={screen.focus}
          framed={!mobile}
        />
      ) : screen.name === 'devices' ? (
        <div className={place}>
          <DevicesScreen controller={controller} session={session} nav={nav} focus={screen.focus} />
        </div>
      ) : screen.name === 'notices' ? (
        <div className={place}>
          <NoticesScreen controller={controller} session={session} nav={nav} />
        </div>
      ) : null}
    </>
  );
  const sidebar = (
    <Sidebar controller={controller} session={session} nav={nav} onChange={refresh} lock={lock} />
  );

  return (
    <ToastRegion>
      <div data-layout={layout} className="flex h-dvh overflow-hidden bg-surface text-fg">
        {layout === 'desktop' ? (
          <aside className="w-64 shrink-0 overflow-y-auto border-r border-line">{sidebar}</aside>
        ) : null}
        {tablet ? (
          <>
            {open ? (
              // Escape and Menu close it too: the backdrop is for the pointer only.
              <div
                aria-hidden="true"
                data-testid="drawer-backdrop"
                className="fixed inset-0 z-10 bg-scrim"
                onClick={() => {
                  setDrawer(false);
                }}
              />
            ) : null}
            <div
              ref={drawerRef}
              id="sidebar-drawer"
              className={`fixed inset-y-0 left-0 z-20 w-72 overflow-y-auto border-r border-line bg-surface shadow-raised ${open ? '' : 'hidden'}`}
            >
              {sidebar}
            </div>
          </>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col">
          {layout === 'desktop' ? null : (
            <Header
              controller={controller}
              session={session}
              nav={nav}
              mobile={mobile}
              wizard={setWizardHeader}
              lock={lock}
              menu={{
                ref: toggleRef,
                'aria-expanded': drawer,
                'aria-controls': 'sidebar-drawer',
                onClick: () => {
                  setDrawer(!drawer);
                },
              }}
            />
          )}
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="scroller">
            <SharedOriginWarning />
            <UpdateDialog />
            {/* A desktop has no header: a main destination's Back sits above it (D316). */}
            {layout === 'desktop' && main ? (
              <div className="px-2 pt-2">
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
              </div>
            ) : null}
            {mobile && isList(screen) && !ready ? (
              <>
                <StatusLine controller={controller} session={session} nav={nav} />
                <UpdateEntry className="mx-4" />
              </>
            ) : null}
            <main className={`flex flex-col ${fill ? 'min-h-0 flex-1' : 'shrink-0'}`}>
              <WizardPlace.Provider value={{ header: mobile ? wizardHeader : null }}>
                {body}
              </WizardPlace.Provider>
            </main>
          </div>
          {mobile && tabbed(screen) ? (
            <footer className="grid grid-cols-4 gap-1 border-t border-line p-1">
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
                    'monitor-smartphone',
                    m.settings.pages.devices,
                    screen.name === 'devices',
                    () => {
                      nav.openMain({ name: 'devices' });
                    },
                  ],
                  [
                    'settings',
                    m.app.settings,
                    screen.name === 'settings',
                    () => {
                      nav.openSettings();
                    },
                  ],
                ] as const
              ).map(([icon, label, current, go]) => (
                <Button
                  key={icon}
                  variant="quiet"
                  className="flex min-w-0 flex-col items-center justify-center gap-1 px-1 text-xs aria-[current]:text-accent-text"
                  aria-current={current ? 'page' : undefined}
                  data-testid={icon === 'monitor-smartphone' ? 'nav-devices' : undefined}
                  onClick={go}
                >
                  <Icon name={icon} />
                  <span className="max-w-full truncate">{label}</span>
                </Button>
              ))}
            </footer>
          ) : null}
        </div>
      </div>
    </ToastRegion>
  );
}
