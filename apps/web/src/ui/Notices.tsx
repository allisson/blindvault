// The vault's state and notices (overview §13.1, §13.2, D316): the notices a vault screen used to
// show above its content are listed on their own screen; the sidebar's status card and the phone's
// status line say how many there are, beside the lock state, the live sync and the last backup.
// The storage warnings cannot be dismissed (D196); every other notice keeps its own way out.

import { type VaultSession } from '@blindvault/vault';
import { type ReactNode, useSyncExternalStore } from 'react';

import { type BackupReminder } from '../app/backup-reminder';
import { type VaultController } from '../app/controller';
import { type Navigation } from '../app/nav';
import { useLanguage } from '../i18n/context';
import { type Messages, format } from '../i18n/messages';
import { Button, LockState } from './components';
import { useLayout } from './hooks';
import { Icon } from './icons';
import { useWarnings, warningText } from './StorageState';

/** One notice: its short line for the card and the status line, its card on the Notices screen. */
interface VaultNotice {
  readonly id: string;
  readonly summary: string;
  readonly card: ReactNode;
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

/** A notice's card: the warning tone, its text, then its actions. */
function NoticeCard({
  testId,
  role = 'note',
  actions,
  children,
  ...data
}: {
  readonly testId: string;
  readonly role?: 'note' | 'alert';
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly 'data-warning'?: string;
}) {
  return (
    <div
      role={role}
      data-testid={testId}
      {...data}
      className="flex flex-col gap-3 rounded-card bg-warning-soft p-4 text-sm text-warning-text"
    >
      <div className="flex gap-2">
        <span className="flex h-5 shrink-0 items-center">
          <Icon name="triangle-alert" />
        </span>
        <div className="flex min-w-0 flex-col gap-2">{children}</div>
      </div>
      {actions ? <div className="flex flex-wrap gap-2 ps-7">{actions}</div> : null}
    </div>
  );
}

/** Every notice that applies to the unlocked vault, the storage warnings first (D196, D316). */
function useNotices(
  controller: VaultController,
  session: VaultSession,
  nav: Navigation,
): readonly VaultNotice[] {
  const { messages: m, language } = useLanguage();
  const { status, warnings } = useWarnings(controller, session);
  const s = m.shell.summary;
  const notices: VaultNotice[] = warnings.map((w) => ({
    id: `storage-${w}`,
    summary: w === 'safari-tab' ? s.safariTab : w === 'not-kept' ? s.notKept : s.nearlyFull,
    card: (
      <NoticeCard testId="storage-warning" data-warning={w} role="alert">
        <p>{warningText(m, language, w, status)}</p>
      </NoticeCard>
    ),
  }));
  // "Vault ready" lists the backup, so the reminder waits until it is closed (D198).
  const ready = controller.ready;
  const reminder = ready ? undefined : controller.backupReminder;
  if (reminder) {
    notices.push({
      id: 'backup-reminder',
      summary: s.backup,
      card: (
        <NoticeCard
          testId="backup-reminder"
          actions={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  nav.openSettings('backup');
                }}
              >
                <Icon name="upload" className="me-2" />
                {m.vault.reminderBackup}
              </Button>
              <Button
                variant="quiet"
                className="text-warning-text"
                onClick={() => {
                  controller.dismissBackupReminder();
                }}
              >
                {m.restore.dismiss}
              </Button>
            </>
          }
        >
          <p>{reminderText(m, language, reminder)}</p>
        </NoticeCard>
      ),
    });
  }
  const clock = controller.clockNotice;
  if (clock) {
    notices.push({
      id: 'clock-behind',
      summary: s.clock,
      card: (
        <NoticeCard
          testId="clock-behind"
          actions={
            clock.far ? (
              <Button
                variant="secondary"
                data-testid="clock-refound"
                onClick={() => {
                  nav.openSettings('refound');
                }}
              >
                {m.refound.title}
              </Button>
            ) : undefined
          }
        >
          <p>
            {format(m.vault.clockBehind, {
              date: new Intl.DateTimeFormat(language, {
                dateStyle: 'long',
                timeStyle: 'short',
              }).format(clock.until),
            })}
          </p>
          {clock.far ? <p>{m.vault.clockFar}</p> : null}
          {clock.far && clock.pairAgain ? <p>{m.vault.clockPairAgain}</p> : null}
        </NoticeCard>
      ),
    });
  }
  if (session.retired) {
    notices.push({
      id: 'own-retired',
      summary: s.retired,
      card: (
        <NoticeCard testId="own-retired">
          <p>{m.merge.ownRetired}</p>
        </NoticeCard>
      ),
    });
  }
  if (controller.afterRestore === 'check-phrase' && !ready) {
    notices.push({
      id: 'after-restore',
      summary: s.checkPhrase,
      card: (
        <NoticeCard
          testId="after-restore"
          actions={
            <Button
              variant="quiet"
              className="text-warning-text"
              onClick={() => {
                controller.dismissAfterRestore();
              }}
            >
              {m.restore.dismiss}
            </Button>
          }
        >
          <p>{m.restore.checkPhrase}</p>
        </NoticeCard>
      ),
    });
  }
  if (controller.afterRefounding) {
    notices.push({
      id: 'refounded',
      summary: s.refounded,
      card: (
        <NoticeCard
          testId="refounded"
          actions={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  controller.dismissRefounded();
                  nav.openSettings();
                }}
              >
                {m.restore.openSettings}
              </Button>
              <Button
                variant="quiet"
                className="text-warning-text"
                onClick={() => {
                  controller.dismissRefounded();
                }}
              >
                {m.restore.dismiss}
              </Button>
            </>
          }
        >
          <p>{m.refound.done}</p>
        </NoticeCard>
      ),
    });
  }
  if (controller.leftoverPasskey) {
    notices.push({
      id: 'leftover-passkey',
      summary: s.leftoverPasskey,
      card: (
        <NoticeCard
          testId="leftover-passkey"
          actions={
            <Button
              variant="quiet"
              className="text-warning-text"
              onClick={() => {
                controller.dismissLeftoverPasskey();
              }}
            >
              {m.restore.dismiss}
            </Button>
          }
        >
          <p>{m.replace.leftoverPasskey}</p>
        </NoticeCard>
      ),
    });
  }
  return notices;
}

function countText(m: Messages, n: number): string {
  return n === 1 ? m.shell.noticesOne : format(m.shell.noticesMany, { n: String(n) });
}

/** The Notices screen: every notice in a card, then the preview build's note (D177, D316). */
export function NoticesScreen({
  controller,
  session,
  nav,
}: {
  readonly controller: VaultController;
  readonly session: VaultSession;
  readonly nav: Navigation;
}) {
  const m = useLanguage().messages;
  const notices = useNotices(controller, session, nav);
  return (
    <div className="flex w-full max-w-2xl flex-col gap-4 p-4" data-testid="notices">
      <h1 tabIndex={-1} className="text-title">
        {m.shell.notices}
      </h1>
      <p className="text-sm text-muted">{m.shell.noticesIntro}</p>
      {notices.map((n) => (
        <div key={n.id} className="contents">
          {n.card}
        </div>
      ))}
      <p role="note" className="flex gap-2 rounded-card bg-subtle p-4 text-sm text-muted">
        <span className="flex h-5 shrink-0 items-center">
          <Icon name="info" />
        </span>
        <span>{m.preview.banner}</span>
      </p>
    </div>
  );
}

/** The live sync and its peer, wherever the user is in the vault (sync-protocol.md §10, D225). */
function useLive(controller: VaultController) {
  const stage = useSyncExternalStore(controller.subscribe, () => controller.sync);
  const peer = useSyncExternalStore(controller.subscribe, () => controller.syncPeer);
  return stage?.kind === 'synced' && stage.live && peer
    ? { peer, unseen: stage.unseen }
    : undefined;
}

function useLastBackup(session: VaultSession): string {
  const { messages: m, language } = useLanguage();
  const last = session.lastBackupAt;
  return last === undefined
    ? m.shell.noBackup
    : format(m.shell.lastBackup, {
        date: new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(last),
      });
}

/** The live sync's line with its two actions: Show opens Devices, End ends it. */
function LiveLine({
  controller,
  nav,
  live,
}: {
  readonly controller: VaultController;
  readonly nav: Navigation;
  readonly live: NonNullable<ReturnType<typeof useLive>>;
}) {
  const m = useLanguage().messages;
  return (
    <div className="flex flex-col gap-1" data-testid="live-sync">
      <p role="status" className="flex items-start gap-2 text-success">
        <span className="flex h-5 shrink-0 items-center">
          <Icon name="refresh-cw" className="size-4" />
        </span>
        <span className="min-w-0">{format(m.shell.live, { name: live.peer.name })}</span>
      </p>
      {live.unseen ? <p className="ps-6 text-xs">{m.sync.liveNotices}</p> : null}
      <div className="flex gap-1 ps-4">
        <Button
          variant="quiet"
          className="px-2"
          onClick={() => {
            nav.openSettings('devices');
          }}
          data-testid="live-sync-show"
        >
          {m.sync.liveShow}
        </Button>
        <Button
          variant="quiet"
          className="px-2"
          onClick={() => {
            controller.cancelSync();
          }}
          data-testid="live-sync-end"
        >
          {m.sync.liveEnd}
        </Button>
      </div>
    </div>
  );
}

/**
 * The sidebar's status card (D316): the lock state, the notices in a warning tone with the way to
 * their screen, the live sync and the last backup made on this device.
 */
export function StatusCard({
  controller,
  session,
  nav,
}: {
  readonly controller: VaultController;
  readonly session: VaultSession;
  readonly nav: Navigation;
}) {
  const m = useLanguage().messages;
  const notices = useNotices(controller, session, nav);
  const live = useLive(controller);
  const backup = useLastBackup(session);
  const warn = notices.length > 0;
  // A tablet's header shows the lock state already; its drawer's card does not repeat it.
  const desktop = useLayout() === 'desktop';
  return (
    <section
      aria-label={m.shell.notices}
      data-testid="status-card"
      data-tone={warn ? 'warning' : undefined}
      className={`flex flex-col gap-2 rounded-card p-3 text-sm ${
        warn ? 'bg-warning-soft text-warning-text' : 'border border-line bg-raised text-muted'
      }`}
    >
      {desktop ? <LockState unlocked className="self-start" /> : null}
      {warn ? (
        <button
          type="button"
          className="-mx-1 flex min-h-10 pointer-coarse:min-h-11 items-center gap-2 rounded-control px-1 text-start font-semibold hover:underline"
          onClick={() => {
            nav.openMain({ name: 'notices' });
          }}
          data-testid="notices-open"
        >
          <Icon name="triangle-alert" className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">{countText(m, notices.length)}</span>
          <Icon name="chevron-right" className="size-4 shrink-0" />
        </button>
      ) : null}
      {notices[0] ? <p>{notices[0].summary}</p> : null}
      {live ? <LiveLine controller={controller} nav={nav} live={live} /> : null}
      <p className="flex items-start gap-2" data-testid="status-backup">
        <span className="flex h-5 shrink-0 items-center">
          <Icon name="upload" className="size-4" />
        </span>
        <span>{backup}</span>
      </p>
    </section>
  );
}

/**
 * A phone's status line above the item list (D316): the notices in a warning tone, else the live
 * sync, else the last backup; the header beside it shows the lock state.
 */
export function StatusLine({
  controller,
  session,
  nav,
}: {
  readonly controller: VaultController;
  readonly session: VaultSession;
  readonly nav: Navigation;
}) {
  const m = useLanguage().messages;
  const notices = useNotices(controller, session, nav);
  const live = useLive(controller);
  const backup = useLastBackup(session);
  const first = notices[0];
  if (first) {
    return (
      <button
        type="button"
        className="mx-4 mt-2 flex min-h-11 items-center gap-2 rounded-card bg-warning-soft px-3 py-2 text-start text-sm font-semibold text-warning-text"
        onClick={() => {
          nav.openMain({ name: 'notices' });
        }}
        data-testid="notices-open"
      >
        <Icon name="triangle-alert" className="size-4 shrink-0" />
        <span className="min-w-0 flex-1">
          {countText(m, notices.length)} · {first.summary}
        </span>
        <Icon name="chevron-right" className="size-4 shrink-0" />
      </button>
    );
  }
  if (live) {
    return (
      <div className="mx-4 mt-2 rounded-card bg-subtle px-3 py-2 text-sm">
        <LiveLine controller={controller} nav={nav} live={live} />
      </div>
    );
  }
  return (
    <p className="mx-4 mt-2 flex items-center gap-2 text-sm text-muted" data-testid="status-line">
      <Icon name="upload" className="size-4 shrink-0" />
      <span>{backup}</span>
    </p>
  );
}

/** The tablet's top bar: how many notices, else the live sync, as one pill (D316). */
export function StatusPill({
  controller,
  session,
  nav,
}: {
  readonly controller: VaultController;
  readonly session: VaultSession;
  readonly nav: Navigation;
}) {
  const m = useLanguage().messages;
  const notices = useNotices(controller, session, nav);
  const live = useLive(controller);
  if (notices.length > 0) {
    return (
      <button
        type="button"
        className="flex min-h-10 pointer-coarse:min-h-11 min-w-0 items-center gap-2 rounded-full bg-warning-soft px-3 text-sm font-semibold text-warning-text"
        onClick={() => {
          nav.openMain({ name: 'notices' });
        }}
        data-testid="status-pill"
      >
        <Icon name="triangle-alert" className="size-4 shrink-0" />
        <span className="truncate">{countText(m, notices.length)}</span>
      </button>
    );
  }
  if (live) {
    return (
      <button
        type="button"
        className="flex min-h-10 pointer-coarse:min-h-11 min-w-0 items-center gap-2 rounded-full bg-subtle px-3 text-sm font-semibold text-success"
        onClick={() => {
          nav.openSettings('devices');
        }}
        data-testid="status-pill"
      >
        <Icon name="refresh-cw" className="size-4 shrink-0" />
        <span className="truncate">{format(m.shell.live, { name: live.peer.name })}</span>
      </button>
    );
  }
  return null;
}
