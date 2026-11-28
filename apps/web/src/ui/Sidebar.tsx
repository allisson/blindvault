// The sidebar (overview §13.1, D316): the app's name, All items, the trash and the folders, then
// Devices and Settings, the status card and Lock now. Always shown on a desktop, in a drawer on a
// tablet; a phone has its bottom bar and status line instead.

import { type VaultSession } from '@blindvault/vault';
import { type ComponentProps, useSyncExternalStore } from 'react';

import { type VaultController } from '../app/controller';
import { devicesOf } from '../app/devices';
import { type Navigation } from '../app/nav';
import { useMessages } from '../i18n/context';
import { Brand, Button, ROW } from './components';
import { FolderPane } from './Folders';
import { Icon, type IconName } from './icons';
import { StatusCard } from './Notices';

function MainEntry({
  icon,
  count,
  current,
  children,
  ...props
}: ComponentProps<'button'> & {
  readonly icon: IconName;
  /** Seen only: the screen it opens says it (D245). */
  readonly count?: number;
  readonly current: boolean;
}) {
  return (
    <button
      type="button"
      className={`${ROW} flex items-center gap-2`}
      aria-current={current ? 'page' : undefined}
      {...props}
    >
      <Icon name={icon} className="text-muted" />
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {count === undefined ? null : (
        <span aria-hidden="true" className="text-xs text-muted">
          {count}
        </span>
      )}
    </button>
  );
}

export function Sidebar({
  controller,
  session,
  nav,
  onChange,
  lock,
}: {
  readonly controller: VaultController;
  readonly session: VaultSession;
  readonly nav: Navigation;
  readonly onChange: () => void;
  /** Lock now's props, shared with the headers (D197). */
  readonly lock: ComponentProps<'button'>;
}) {
  const m = useMessages();
  const screen = useSyncExternalStore(nav.subscribe, nav.current);
  return (
    <div className="flex min-h-full flex-col gap-2 pb-3">
      <div className="px-5 pt-4 pb-1">
        <Brand />
      </div>
      <FolderPane session={session} nav={nav} onChange={onChange} />
      <span className="flex-1" />
      <nav aria-label={m.shell.navigation} className="flex flex-col gap-1 px-3">
        <MainEntry
          icon="monitor-smartphone"
          count={devicesOf(session).listed.length}
          current={screen.name === 'devices'}
          data-testid="nav-devices"
          onClick={() => {
            nav.openMain({ name: 'devices' });
          }}
        >
          {m.settings.pages.devices}
        </MainEntry>
        <MainEntry
          icon="settings"
          current={screen.name === 'settings'}
          data-testid="nav-settings"
          onClick={() => {
            nav.openSettings();
          }}
        >
          {m.app.settings}
        </MainEntry>
      </nav>
      <div className="flex flex-col gap-2 px-3">
        <StatusCard controller={controller} session={session} nav={nav} />
        <Button variant="secondary" className="flex items-center justify-start" {...lock}>
          <Icon name="lock" className="me-2" />
          {m.shell.lockNow}
        </Button>
      </div>
    </div>
  );
}
