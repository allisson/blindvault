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
import { platform } from '../platform';
import type { Platform } from '../platform/platform';
import { Button, Notice, StorageAlert } from './components';

const KB = 1000;

/** `n` bytes in decimal units, as the storage state shows them. */
export function bytes(language: string, n: number): string {
  const [value, unit] =
    n >= KB ** 3
      ? [n / KB ** 3, 'gigabyte']
      : n >= KB ** 2
        ? [n / KB ** 2, 'megabyte']
        : n >= KB
          ? [n / KB, 'kilobyte']
          : [n, 'byte'];
  return new Intl.NumberFormat(language, {
    style: 'unit',
    unit,
    maximumFractionDigits: 1,
  }).format(value);
}

export function percent(language: string, usage: number, quota: number): string {
  return new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 0 }).format(
    usage / quota,
  );
}

/**
 * The storage state's texts on a platform. The Android app's data is never evicted: it goes only
 * with the app or its data, and `persist()` always answers `false` there (android.md §11, D298).
 */
export function storageTexts(m: Messages, kind: Platform['kind']) {
  const android = kind === 'android';
  return {
    notKeptOnly: android ? m.storage.androidNotKeptOnly : m.storage.notKeptOnly,
    nearlyFull: android ? m.storage.androidNearlyFull : m.storage.nearlyFull,
    persistence: (persisted: boolean | null): string =>
      android
        ? m.storage.androidKept
        : persisted === true
          ? m.storage.kept
          : persisted === false
            ? m.storage.notKept
            : m.storage.unknown,
    /** Whether asking the browser to keep the storage can change anything. */
    canAsk: !android,
  };
}

function warningText(
  m: Messages,
  language: string,
  warning: StorageWarning,
  status: StorageStatus | undefined,
): string {
  const texts = storageTexts(m, platform.kind);
  switch (warning) {
    case 'safari-tab':
      return m.storage.safariTab;
    case 'not-kept':
      return texts.notKeptOnly;
    case 'nearly-full':
      return format(texts.nearlyFull, {
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
  const texts = storageTexts(m, platform.kind);
  return (
    <section className="flex flex-col gap-4" data-testid="device-storage">
      <p className="text-sm" data-testid="storage-persistence">
        {texts.persistence(persisted)}
      </p>
      {persisted === false && texts.canAsk ? (
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
      <div className="flex flex-col gap-2">
        <p className="text-sm" data-testid="storage-usage">
          {usage !== null && quota !== null && quota > 0
            ? format(m.storage.usage, {
                used: bytes(language, usage),
                quota: bytes(language, quota),
                percent: percent(language, usage, quota),
              })
            : m.storage.usageUnknown}
        </p>
        {/* The text above says it; the bar only shows it (D315). */}
        {usage !== null && quota !== null && quota > 0 ? (
          <div aria-hidden="true" className="h-1 overflow-hidden rounded-full bg-line">
            <div
              data-testid="storage-bar"
              className={`h-full rounded-full ${warnings.includes('nearly-full') ? 'bg-warning' : 'bg-accent'}`}
              style={{ width: `${String(Math.min(100, (usage / quota) * 100))}%` }}
            />
          </div>
        ) : null}
      </div>
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
