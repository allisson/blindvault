import { DEFAULT_PREFERENCES } from '@blindvault/vault';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { BackButton, browserHistory } from './app/back-button';
import { clipboard } from './app/clipboard';
import { type VaultController } from './app/controller';
import { LockTimers } from './app/lock-timers';
import { Navigation } from './app/nav';
import { type UpdateMonitor } from './app/updates';
import { LanguageProvider } from './i18n/context';
import { platform } from './platform';
import { AboutContext } from './ui/about-context';
import { ChangedWorker } from './ui/ChangedWorker';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { Start } from './ui/Start';
import { UpdatesContext } from './ui/update-context';
import { VaultShell } from './ui/VaultShell';

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
  const drops = useSyncExternalStore(controller.subscribe, () => controller.drops);
  // "Continue in this tab" outlives the new Start of each lock, not a reload (D198, D263).
  const inTab = useState(false);
  // The system's back goes one screen back, through one history entry that carries nothing (D197).
  useEffect(() => new BackButton(nav, browserHistory()).start(), [nav]);

  useEffect(() => {
    if (supported()) void controller.start();
  }, [controller]);

  // Both locks run while unlocked, with the vault's preferences (D54, D151), and with the defaults
  // while a creation or a restore holds a phrase or a backup before its commit (D104, D263).
  const pendingCommit = useSyncExternalStore(controller.subscribe, () => controller.pendingCommit);
  const preferences =
    status.kind === 'unlocked'
      ? status.session.preferences
      : pendingCommit
        ? DEFAULT_PREFERENCES
        : undefined;
  useEffect(() => {
    if (!preferences) {
      timers.stop();
      nav.reset();
      // A copied secret does not outlive the unlocked vault, as far as the browser allows (D54).
      clipboard.lock();
      return;
    }
    const signals = platform.lockSignals;
    timers.start(preferences, signals.hidden());
    const stopActivity = signals.onActivity(() => {
      timers.activity();
    });
    const stopHidden = signals.onHidden((hidden) => {
      timers.visibility(hidden);
    });
    const stopSystemLock = signals.onSystemLock(() => {
      controller.lock();
    });
    const shortcut = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        controller.lock();
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => {
      stopActivity();
      stopHidden();
      stopSystemLock();
      window.removeEventListener('keydown', shortcut);
      timers.stop();
    };
  }, [preferences, timers, nav, controller]);

  // Joining a pairing, B holds no vault and so no lock preference: the app hidden for the default
  // delay ends the pairing as a lock would (D93, D203).
  const joining = status.kind === 'joining';
  useEffect(() => {
    if (!joining) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const visibility = (hidden: boolean) => {
      clearTimeout(timer);
      timer = undefined;
      if (!hidden) return;
      timer = setTimeout(() => {
        controller.lock();
      }, DEFAULT_PREFERENCES.hiddenLockSeconds * 1000);
    };
    visibility(platform.lockSignals.hidden());
    const stop = platform.lockSignals.onHidden(visibility);
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [joining, controller]);

  // The inactivity lock pauses while a Recovery Phrase is shown (D104, D185, D187).
  const showingPhrase = useSyncExternalStore(controller.subscribe, () => controller.showingPhrase);
  useEffect(() => {
    if (showingPhrase) timers.pause();
    else timers.resume();
  }, [showingPhrase, timers]);

  // A changed sw.js locked the vault; its warning comes before every screen (D63, D191).
  const updates = useSyncExternalStore(monitor.subscribe, monitor.getState);
  if (updates.warning) return <ChangedWorker monitor={monitor} />;

  if (!supported()) {
    return <Start controller={controller} status={{ kind: 'unsupported' }} inTab={inTab} />;
  }
  if (status.kind === 'unlocked') {
    return <VaultShell controller={controller} session={status.session} nav={nav} />;
  }
  // A new Start after a lock drops a creation's words or a restore's backup (D263).
  return <Start key={drops} controller={controller} status={status} inTab={inTab} />;
}

export function App({ controller, monitor }: RootProps) {
  const updates = useMemo(() => ({ controller, monitor }), [controller, monitor]);
  const about = useState(false);
  const [, setAbout] = about;
  // Unlocking leaves the About card: Settings shows it from then on (D192).
  const unlocked = useSyncExternalStore(
    controller.subscribe,
    () => controller.status.kind === 'unlocked',
  );
  useEffect(() => {
    if (unlocked) setAbout(false);
  }, [unlocked, setAbout]);
  return (
    <LanguageProvider>
      <UpdatesContext.Provider value={updates}>
        <AboutContext.Provider value={about}>
          <ErrorBoundary controller={controller}>
            <Root controller={controller} monitor={monitor} />
          </ErrorBoundary>
        </AboutContext.Provider>
      </UpdatesContext.Provider>
    </LanguageProvider>
  );
}
