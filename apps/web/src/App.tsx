import { useEffect, useMemo, useSyncExternalStore } from 'react';

import { clipboard } from './app/clipboard';
import { type VaultController } from './app/controller';
import { LockTimers } from './app/lock-timers';
import { Navigation } from './app/nav';
import { type UpdateMonitor } from './app/updates';
import { LanguageProvider } from './i18n/context';
import { ChangedWorker } from './ui/ChangedWorker';
import { Start } from './ui/Start';
import { UpdatesContext } from './ui/update-context';
import { VaultShell } from './ui/VaultShell';

const ACTIVITY = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

export function supported(): boolean {
  return typeof indexedDB !== 'undefined' && typeof navigator.locks !== 'undefined';
}

interface RootProps {
  readonly controller: VaultController;
  readonly monitor: UpdateMonitor;
}

function Root({ controller, monitor }: RootProps) {
  const nav = useMemo(() => new Navigation(), []);
  const timers = useMemo(
    () =>
      new LockTimers(() => {
        controller.lock();
      }),
    [controller],
  );
  const status = useSyncExternalStore(controller.subscribe, controller.getStatus);

  useEffect(() => {
    if (supported()) void controller.start();
  }, [controller]);

  // Both locks run while unlocked, with the vault's preferences (D54, D151).
  const preferences = status.kind === 'unlocked' ? status.session.preferences : undefined;
  useEffect(() => {
    if (!preferences) {
      timers.stop();
      nav.reset();
      // A copied secret does not outlive the unlocked vault, as far as the browser allows (D54).
      clipboard.lock();
      return;
    }
    timers.start(preferences, document.visibilityState === 'hidden');
    const activity = () => {
      timers.activity();
    };
    const visibility = () => {
      timers.visibility(document.visibilityState === 'hidden');
    };
    const shortcut = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        controller.lock();
      }
    };
    for (const type of ACTIVITY) window.addEventListener(type, activity, { passive: true });
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('keydown', shortcut);
    return () => {
      for (const type of ACTIVITY) window.removeEventListener(type, activity);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('keydown', shortcut);
      timers.stop();
    };
  }, [preferences, timers, nav, controller]);

  // The inactivity lock pauses while a regeneration's Recovery Phrase is shown (D104, D185).
  const showingPhrase = useSyncExternalStore(controller.subscribe, () => controller.showingPhrase);
  useEffect(() => {
    if (showingPhrase) timers.pause();
    else timers.resume();
  }, [showingPhrase, timers]);

  // A changed sw.js locked the vault; its warning comes before every screen (D63, D191).
  const updates = useSyncExternalStore(monitor.subscribe, monitor.getState);
  if (updates.warning) return <ChangedWorker monitor={monitor} />;

  if (!supported()) return <Start controller={controller} status={{ kind: 'unsupported' }} />;
  if (status.kind === 'unlocked') {
    return <VaultShell controller={controller} session={status.session} nav={nav} />;
  }
  return <Start controller={controller} status={status} />;
}

export function App({ controller, monitor }: RootProps) {
  const updates = useMemo(() => ({ controller, monitor }), [controller, monitor]);
  return (
    <LanguageProvider>
      <UpdatesContext.Provider value={updates}>
        <Root controller={controller} monitor={monitor} />
      </UpdatesContext.Provider>
    </LanguageProvider>
  );
}
