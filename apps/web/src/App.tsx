import { useEffect, useMemo, useSyncExternalStore } from 'react';

import { VaultController } from './app/controller';
import { kdfWorker } from './app/kdf';
import { LockTimers } from './app/lock-timers';
import { Navigation } from './app/nav';
import { LanguageProvider } from './i18n/context';
import { Start } from './ui/Start';
import { VaultShell } from './ui/VaultShell';

const ACTIVITY = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

function supported(): boolean {
  return typeof indexedDB !== 'undefined' && typeof navigator.locks !== 'undefined';
}

function Root() {
  const controller = useMemo(
    () =>
      new VaultController({
        factory: indexedDB,
        locks: navigator.locks,
        kdf: kdfWorker,
        storage: navigator.storage,
      }),
    [],
  );
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

  if (!supported()) return <Start controller={controller} status={{ kind: 'unsupported' }} />;
  if (status.kind === 'unlocked') {
    return <VaultShell controller={controller} session={status.session} nav={nav} />;
  }
  return <Start controller={controller} status={status} />;
}

export function App() {
  return (
    <LanguageProvider>
      <Root />
    </LanguageProvider>
  );
}
