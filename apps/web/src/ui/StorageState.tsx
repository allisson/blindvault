// The storage state (overview §7, §13.2, D55, D119, D196): the "This device" section of Settings,
// with the last backup and the last sync (D34, D226),
// and the storage warning below the vault's header. The Safari warning before unlock is in
// `components.tsx`, with the cards.

import { type StorageStatus } from '@blindvault/storage';
import { type VaultSession } from '@blindvault/vault';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { type VaultController } from '../app/controller';
import { devicesOf, lastSyncOf } from '../app/devices';
import { type StorageWarning, safariTab, storageWarnings } from '../app/storage-state';
import { useLanguage } from '../i18n/context';
import { type Messages, format } from '../i18n/messages';
import { Button, Notice, StorageAlert } from './components';

const KB = 1000;

function bytes(language: string, n: number): string {
  const [value, unit] =
    n >= KB ** 3
      ? [n / KB ** 3, 'gigabyte']
      : n >= KB ** 2
        ? [n / KB ** 2, 'megabyte']
        : [n / KB, 'kilobyte'];
  return new Intl.NumberFormat(language, {
    style: 'unit',
    unit,
    maximumFractionDigits: 1,
  }).format(value);
}

function percent(language: string, usage: number, quota: number): string {
  return new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 0 }).format(
    usage / quota,
  );
}

function warningText(
  m: Messages,
  language: string,
  warning: StorageWarning,
  status: StorageStatus | undefined,
): string {
  switch (warning) {
    case 'safari-tab':
      return m.storage.safariTab;
    case 'not-kept':
      return m.storage.notKeptOnly;
    case 'nearly-full':
      return format(m.storage.nearlyFull, {
        percent: percent(language, status?.usage ?? 0, status?.quota ?? 1),
      });
  }
}

function useStorage(controller: VaultController): StorageStatus | undefined {
  return useSyncExternalStore(controller.storage.subscribe, controller.storage.getState);
}

/** Every warning that applies to the unlocked vault, the most serious first. */
function useWarnings(controller: VaultController, session: VaultSession) {
  const status = useStorage(controller);
  const warnings = storageWarnings({
    safariTab: safariTab(),
    persisted: status?.persisted ?? null,
    onlyDevice: devicesOf(session).advice === 'only-device',
    usage: status?.usage ?? null,
    quota: status?.quota ?? null,
  });
  return { status, warnings };
}

/**
 * The most serious storage warning, below the vault's header in every layout. It reads the status
 * at unlock and on every return to visible (D196); none of the warnings can be dismissed.
 */
export function StorageWarningBanner({
  controller,
  session,
}: {
  readonly controller: VaultController;
  readonly session: VaultSession;
}) {
  const { messages: m, language } = useLanguage();
  useEffect(() => {
    void controller.storage.refresh();
    const visible = () => {
      if (document.visibilityState === 'visible') void controller.storage.refresh();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      document.removeEventListener('visibilitychange', visible);
    };
  }, [controller]);
  const { status, warnings } = useWarnings(controller, session);
  const first = warnings[0];
  if (!first) return null;
  return <StorageAlert warning={first} text={warningText(m, language, first, status)} />;
}

/** "This device" in Settings: persistence, storage used, last backup and sync, and every warning (D196, D226). */
export function DeviceStorage({
  controller,
  session,
}: {
  readonly controller: VaultController;
  readonly session: VaultSession;
}) {
  const { messages: m, language } = useLanguage();
  const { status, warnings } = useWarnings(controller, session);
  const [refused, setRefused] = useState(false);
  const [asking, setAsking] = useState(false);
  const persisted = status?.persisted ?? null;
  const last = session.lastBackupAt;
  // Read again as a sync commits (D225).
  useSyncExternalStore(controller.subscribe, () => controller.sync);
  const lastSync = lastSyncOf(session);
  const when = new Intl.DateTimeFormat(language, { dateStyle: 'long', timeStyle: 'short' });
  const usage = status?.usage ?? null;
  const quota = status?.quota ?? null;
  return (
    <section className="flex flex-col gap-4" data-testid="device-storage">
      <h2 className="font-semibold">{m.storage.title}</h2>
      <p className="text-sm" data-testid="storage-persistence">
        {persisted === true
          ? m.storage.kept
          : persisted === false
            ? m.storage.notKept
            : m.storage.unknown}
      </p>
      {persisted === false ? (
        <Button
          variant="quiet"
          className="self-start"
          disabled={asking}
          onClick={() => {
            setAsking(true);
            setRefused(false);
            // Called in the click itself: Firefox may prompt, and wants the user activation.
            void controller.storage.keep().then((kept) => {
              setAsking(false);
              setRefused(!kept);
            });
          }}
        >
          {m.storage.ask}
        </Button>
      ) : null}
      {refused && persisted === false ? <Notice>{m.storage.refused}</Notice> : null}
      <p className="text-sm" data-testid="storage-usage">
        {usage !== null && quota !== null && quota > 0
          ? format(m.storage.usage, {
              used: bytes(language, usage),
              quota: bytes(language, quota),
              percent: percent(language, usage, quota),
            })
          : m.storage.usageUnknown}
      </p>
      <p className="text-sm" data-testid="device-last-backup">
        {last === undefined
          ? m.settings.backupNever
          : format(m.settings.backupLast, { date: when.format(last) })}
      </p>
      <p className="text-sm" data-testid="device-last-sync-any">
        {lastSync === undefined
          ? m.storage.syncNever
          : lastSync.name === undefined
            ? format(m.storage.syncLastUnnamed, { date: when.format(lastSync.at) })
            : format(m.storage.syncLast, { date: when.format(lastSync.at), name: lastSync.name })}
      </p>
      {warnings.length > 0 ? (
        <div className="flex flex-col gap-2" data-testid="storage-warnings">
          {warnings.map((w) => (
            <Notice key={w}>{warningText(m, language, w, status)}</Notice>
          ))}
        </div>
      ) : null}
    </section>
  );
}
