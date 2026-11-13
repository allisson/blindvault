import { RecordType } from '@blindvault/crypto';
import {
  DISPLAY_NAME_MAX,
  type Preferences,
  type SyncPurpose,
  type VaultSession,
} from '@blindvault/vault';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useState,
  useSyncExternalStore,
} from 'react';

import {
  ACCENTS,
  type Appearance,
  THEMES,
  currentAppearance,
  setAppearance,
} from '../app/appearance';
import { download, phraseLabel, recordIdPrefix } from '../app/backup-file';
import { devicesOf, eraseAdvice, peerSyncState, rejectedPeersOf } from '../app/devices';
import { folderNameOf } from '../app/folders';
import { type Navigation, type SettingsFocus, type SettingsPage } from '../app/nav';
import {
  type BackupExport,
  type ExportAuth,
  type PasskeySetup,
  type PhraseCheck,
  type VaultController,
} from '../app/controller';
import { useLanguage } from '../i18n/context';
import { LANGUAGES, type Language, type Messages, format } from '../i18n/messages';
import { AboutBuild } from './About';
import { Button, ConfirmDialog, Field, INPUT, Notice, TARGET, TextArea } from './components';
import { EraseVault } from './EraseVault';
import { ExportPassword } from './ExportPassword';
import { ImportItems } from './ImportItems';
import { MergeBackup } from './MergeBackup';
import { NewPassword } from './NewPassword';
import { InviteDevice, ReadmitDevice } from './Pairing';
import { SyncDevice } from './Sync';
import { RefoundVault } from './RefoundVault';
import { OpenBackup, RegeneratePhrase, focusBackup, useOpenBackup } from './RegeneratePhrase';
import { Icon, type IconName } from './icons';
import { DeviceStorage } from './StorageState';

/** The index's groups, in order; the last has no title (D252). */
const GROUPS: readonly (readonly [
  keyof Messages['settings']['groups'] | undefined,
  readonly SettingsPage[],
])[] = [
  ['preferences', ['appearance', 'language', 'locking']],
  ['security', ['password', 'passkey', 'recovery']],
  ['devices', ['devices']],
  ['data', ['backup', 'merge', 'import', 'storage']],
  ['danger', ['refound', 'erase']],
  [undefined, ['about']],
];

const PAGE_ICON: Readonly<Record<SettingsPage, IconName>> = {
  appearance: 'palette',
  language: 'languages',
  locking: 'timer',
  password: 'key-round',
  passkey: 'fingerprint',
  recovery: 'shield-check',
  devices: 'monitor-smartphone',
  backup: 'upload',
  merge: 'git-merge',
  import: 'download',
  storage: 'hard-drive',
  refound: 'refresh-cw',
  erase: 'trash-2',
  about: 'info',
};

const LANGUAGE_NAME: Readonly<Record<Language, string>> = {
  en: 'English',
  'pt-BR': 'Português (Brasil)',
};

/**
 * Settings (D252): an index of pages in groups, each row with its current value where one helps;
 * a row opens its page over the index, and back returns to it.
 */
export function Settings({
  controller,
  session,
  nav,
  page,
  focus,
  framed = false,
}: {
  readonly controller: VaultController;
  readonly session: VaultSession;
  readonly nav: Navigation;
  readonly page?: SettingsPage | undefined;
  /**
   * Opened from the backup reminder (D188), "Vault ready" (D198) or the clock notice (D221): where
   * the cursor goes on `page`.
   */
  readonly focus?: SettingsFocus | undefined;
  /**
   * Tablet and desktop: inside the vault frame, All items, Trash and the index on the left and the
   * open page on the right (D254). A phone drills down from the index.
   */
  readonly framed?: boolean;
}) {
  const m = useLanguage().messages;
  const openBackup = useCallback(() => {
    nav.openSettings('backup');
  }, [nav]);
  const view = page ? (
    <SettingsPageView
      key={page}
      controller={controller}
      session={session}
      nav={nav}
      page={page}
      focus={focus}
    />
  ) : null;
  if (!framed) {
    return (
      <OpenBackup.Provider value={openBackup}>
        {view ?? <SettingsIndex session={session} nav={nav} />}
      </OpenBackup.Provider>
    );
  }
  return (
    <OpenBackup.Provider value={openBackup}>
      <div className="grid min-h-0 flex-1 grid-cols-[16rem_1fr] grid-rows-[minmax(0,1fr)]">
        <div className="flex flex-col gap-4 overflow-y-auto border-r border-line p-2">
          <div className="flex flex-col">
            {(
              [
                ['list', m.vault.allItems, 'vault'],
                ['trash-2', m.vault.trash, 'trash'],
              ] as const
            ).map(([icon, label, list]) => (
              <Button
                key={list}
                variant="quiet"
                className="flex items-center gap-3 text-start"
                onClick={() => {
                  nav.showList({ name: list });
                }}
              >
                <Icon name={icon} />
                {label}
              </Button>
            ))}
          </div>
          <SettingsIndex session={session} nav={nav} framed current={page} />
        </div>
        <div className="flex min-w-0 justify-center overflow-y-auto">
          {view ?? <p className="p-4 text-sm text-muted">{m.settings.choose}</p>}
        </div>
      </div>
    </OpenBackup.Provider>
  );
}

function SettingsIndex({
  session,
  nav,
  framed = false,
  current,
}: {
  readonly session: VaultSession;
  readonly nav: Navigation;
  /** In the vault frame, beside the open page: its row is marked, and a row swaps the page. */
  readonly framed?: boolean;
  readonly current?: SettingsPage | undefined;
}) {
  const { messages: m, language } = useLanguage();
  const s = m.settings;
  const last = session.lastBackupAt;
  const hint: Partial<Record<SettingsPage, string | undefined>> = {
    appearance: s.themes[currentAppearance().theme],
    language: LANGUAGE_NAME[language],
    locking: format(s.hintMinutes, { n: String(session.preferences.autoLockMinutes) }),
    passkey: session.passkeyCredentialId === undefined ? s.hintOff : s.hintOn,
    backup:
      last === undefined
        ? s.hintNever
        : new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(last),
    devices: String(devicesOf(session).listed.length),
  };
  const Title = framed ? 'h2' : 'h1';
  return (
    <div className={`flex w-full max-w-md flex-col p-4 ${framed ? 'gap-4 px-2' : 'gap-6'}`}>
      <Title
        className={
          framed
            ? 'px-2 text-xs font-bold tracking-wide text-muted uppercase'
            : 'text-xl font-semibold'
        }
      >
        {s.title}
      </Title>
      {GROUPS.map(([group, pages]) => (
        <SettingsGroup
          key={group ?? 'other'}
          title={group ? s.groups[group] : undefined}
          framed={framed}
        >
          {pages.map((page) => (
            <li key={page}>
              <button
                type="button"
                aria-current={page === current ? 'page' : undefined}
                className={`${TARGET} flex w-full items-center gap-3 text-start hover:bg-subtle aria-[current]:bg-subtle aria-[current]:font-medium ${framed ? 'rounded-control px-2' : 'px-4 py-2'} ${group === 'danger' ? 'text-danger' : ''}`}
                onClick={() => {
                  // Beside a page, a row swaps it, so back still leads to the index (D252, D254).
                  if (current) nav.replace({ name: 'settings', page });
                  else nav.open({ name: 'settings', page });
                }}
                data-testid={`settings-${page}`}
              >
                <Icon name={PAGE_ICON[page]} />
                <span className="min-w-0 flex-1">{s.pages[page]}</span>
                {hint[page] ? (
                  <span className="min-w-0 truncate text-sm text-muted">{hint[page]}</span>
                ) : null}
                {framed ? null : <Icon name="chevron-right" className="text-muted" />}
              </button>
            </li>
          ))}
        </SettingsGroup>
      ))}
    </div>
  );
}

function SettingsGroup({
  title,
  framed,
  children,
}: {
  readonly title: string | undefined;
  readonly framed: boolean;
  readonly children: ReactNode;
}) {
  const id = useId();
  const Heading = framed ? 'h3' : 'h2';
  return (
    <section {...(title ? { 'aria-labelledby': id } : {})} className="flex flex-col gap-2">
      {title ? (
        <Heading id={id} className="px-2 text-xs font-bold tracking-wide text-muted uppercase">
          {title}
        </Heading>
      ) : null}
      <ul
        className={
          framed
            ? 'flex flex-col'
            : 'divide-y divide-line overflow-hidden rounded-card border border-line bg-raised'
        }
      >
        {children}
      </ul>
    </section>
  );
}

/** One page of Settings, under its heading. Opened without a focus, the heading takes the cursor. */
function SettingsPageView({
  controller,
  session,
  nav,
  page,
  focus,
}: {
  readonly controller: VaultController;
  readonly session: VaultSession;
  readonly nav: Navigation;
  readonly page: SettingsPage;
  readonly focus: SettingsFocus | undefined;
}) {
  const { messages: m, language, setLanguage } = useLanguage();
  useEffect(() => {
    if (focus === 'backup') focusBackup();
    // The passkey page shows once support is known: it focuses itself.
    else if (focus === 'pair') focusField('invite-password');
    else if (focus === 'readmit') focusField('readmission-first');
    else if (focus === 'recovery' || focus === 'refound' || focus === 'import') focusPage();
    else if (focus !== 'passkey') focusHeading();
  }, [focus]);
  const content: Record<SettingsPage, () => ReactNode> = {
    appearance: () => <AppearanceSettings />,
    language: () => (
      <label className="flex flex-col gap-1 text-sm font-medium">
        {m.settings.language}
        <select
          className={INPUT}
          value={language}
          onChange={(e) => {
            const next = LANGUAGES.find((l) => l === e.target.value);
            if (next) setLanguage(next);
          }}
        >
          {LANGUAGES.map((l) => (
            <option key={l} value={l}>
              {LANGUAGE_NAME[l]}
            </option>
          ))}
        </select>
      </label>
    ),
    locking: () => <LockSettings controller={controller} preferences={session.preferences} />,
    password: () => <ChangePassword controller={controller} />,
    passkey: () => (
      <PasskeySettings controller={controller} session={session} focus={focus === 'passkey'} />
    ),
    recovery: () => <RecoveryPhraseSettings controller={controller} session={session} />,
    devices: () => (
      <DeviceSettings
        controller={controller}
        session={session}
        open={focus === 'pair' || focus === 'readmit' ? focus : undefined}
      />
    ),
    backup: () => <BackupSettings controller={controller} session={session} />,
    merge: () => <MergeBackup controller={controller} session={session} />,
    import: () => <ImportItems controller={controller} session={session} />,
    storage: () => <DeviceStorage controller={controller} session={session} />,
    refound: () => <RefoundVault controller={controller} session={session} nav={nav} />,
    erase: () => <EraseSettings controller={controller} session={session} />,
    about: () => <AboutBuild />,
  };
  return (
    <div className="flex w-full max-w-md flex-col gap-6 p-4" data-settings-page={page}>
      <h1 tabIndex={-1} className="text-xl font-semibold">
        {m.settings.pages[page]}
      </h1>
      {content[page]()}
    </div>
  );
}

/** Theme and accent (D231): applied at once and kept for the installation, never synchronized. */
function AppearanceSettings() {
  const m = useLanguage().messages;
  const [appearance, setState] = useState(currentAppearance);
  const choose = (next: Appearance) => {
    setAppearance(next);
    setState(next);
  };
  return (
    <section className="flex flex-col gap-4" data-section="appearance">
      <fieldset className="flex flex-col">
        <legend className="text-sm font-medium">{m.settings.theme}</legend>
        {THEMES.map((theme) => (
          <label key={theme} className={`${TARGET} flex items-center gap-2`}>
            <input
              type="radio"
              name="appearance-theme"
              checked={appearance.theme === theme}
              onChange={() => {
                choose({ ...appearance, theme });
              }}
            />
            {m.settings.themes[theme]}
          </label>
        ))}
      </fieldset>
      <fieldset className="flex flex-col">
        <legend className="text-sm font-medium">{m.settings.accent}</legend>
        {ACCENTS.map((accent) => (
          <label key={accent} className={`${TARGET} flex items-center gap-2`}>
            <input
              type="radio"
              name="appearance-accent"
              checked={appearance.accent === accent}
              onChange={() => {
                choose({ ...appearance, accent });
              }}
            />
            {/* Scoped by `data-accent`, the swatch shows its own accent in the current theme. */}
            <span
              aria-hidden="true"
              data-accent={accent}
              className="size-4 rounded-full bg-accent"
            />
            {m.settings.accents[accent]}
          </label>
        ))}
      </fieldset>
    </section>
  );
}

function ChangePassword({ controller }: { readonly controller: VaultController }) {
  const m = useLanguage().messages;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'working' | 'done' | 'wrong'>('idle');
  const [form, setForm] = useState(0);
  const onChange = useCallback((p: string | null) => {
    setNext(p);
  }, []);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!next) return;
        setState('working');
        void controller.changePassword(current, next).then((outcome) => {
          setCurrent('');
          if (outcome === 'ok') {
            setState('done');
            setForm((f) => f + 1);
          } else if (outcome === 'wrong-password') {
            setState('wrong');
          } else {
            // Locked meanwhile: this screen is gone, and nothing changed.
            setState('idle');
          }
        });
      }}
    >
      <Field
        label={m.settings.current}
        type="password"
        autoComplete="current-password"
        value={current}
        onChange={(e) => {
          setCurrent(e.target.value);
          setState('idle');
        }}
        error={state === 'wrong' ? m.settings.wrong : undefined}
        data-testid="current-password"
      />
      <NewPassword
        key={form}
        label={m.settings.next}
        confirmLabel={m.settings.confirm}
        onChange={onChange}
      />
      <Button type="submit" disabled={current === '' || !next || state === 'working'}>
        {state === 'working' ? m.settings.changing : m.settings.change}
      </Button>
      {state === 'done' ? <p role="status">{m.settings.changed}</p> : null}
    </form>
  );
}

function LockSettings({
  controller,
  preferences,
}: {
  readonly controller: VaultController;
  readonly preferences: Preferences;
}) {
  const m = useLanguage().messages;
  const [values, setValues] = useState(() => ({
    autoLockMinutes: String(preferences.autoLockMinutes),
    hiddenLockSeconds: String(preferences.hiddenLockSeconds),
    clipboardClearSeconds: String(preferences.clipboardClearSeconds),
  }));
  const [state, setState] = useState<'idle' | 'saved' | 'invalid'>('idle');
  const field = (key: keyof typeof values, label: string, min: number, max: number) => (
    <Field
      label={label}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      step={1}
      value={values[key]}
      onChange={(e) => {
        setValues({ ...values, [key]: e.target.value });
        setState('idle');
      }}
      data-testid={key}
    />
  );
  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        // Refused, never clamped (D151).
        controller
          .setPreferences({
            autoLockMinutes: Number(values.autoLockMinutes),
            hiddenLockSeconds: Number(values.hiddenLockSeconds),
            clipboardClearSeconds: Number(values.clipboardClearSeconds),
          })
          .then(
            () => {
              setState('saved');
            },
            () => {
              setState('invalid');
            },
          );
      }}
    >
      {field('autoLockMinutes', m.settings.autoLock, 1, 60)}
      {field('hiddenLockSeconds', m.settings.hiddenLock, 0, 900)}
      {values.hiddenLockSeconds === '0' ? (
        <p className="text-sm text-muted">{m.settings.hiddenImmediate}</p>
      ) : null}
      {field('clipboardClearSeconds', m.settings.clipboard, 10, 120)}
      <Button type="submit">{m.settings.save}</Button>
      {state === 'saved' ? <p role="status">{m.settings.saved}</p> : null}
      {state === 'invalid' ? (
        <p role="alert" className="text-sm text-danger">
          {m.settings.outOfRange}
        </p>
      ) : null}
    </form>
  );
}

type PasskeyState =
  | { readonly kind: 'idle' | 'working' | 'removed' | 'removed-by-hand' }
  | { readonly kind: 'done'; readonly backupEligible: boolean }
  | { readonly kind: Exclude<PasskeySetup['kind'], 'ok'> };

/**
 * Passkey unlock (§5.5): says what then protects a lost device (D75) and, for a synced passkey,
 * what it then depends on (D84). Setup asks for the local password (D172).
 */
/** Erase, while unlocked: it names this device's Device record (§7, D41, D205). */
function EraseSettings({
  controller,
  session,
}: {
  readonly controller: VaultController;
  readonly session: VaultSession;
}) {
  const m = useLanguage().messages;
  const openBackup = useOpenBackup();
  const [open, setOpen] = useState(false);
  return (
    <section className="flex flex-col gap-4" data-section="erase">
      <p className="text-sm">{m.erase.intro}</p>
      {open ? (
        <EraseVault
          controller={controller}
          advice={eraseAdvice(devicesOf(session))}
          onBackup={openBackup}
          onCancel={() => {
            setOpen(false);
          }}
        />
      ) : (
        <Button
          variant="quiet"
          className="self-start"
          onClick={() => {
            setOpen(true);
          }}
        >
          {m.erase.choose}
        </Button>
      )}
    </section>
  );
}

/** The open page's heading takes the cursor, as a new screen (D252). */
function focusHeading(): void {
  document.querySelector<HTMLElement>('[data-settings-page] h1')?.focus();
}

/** Puts the cursor in the open page's first field, or on its heading (D198, D252). */
function focusPage(): void {
  const page = document.querySelector('[data-settings-page]');
  const target = page?.querySelector<HTMLElement>('input, textarea') ?? page?.querySelector('h1');
  target?.scrollIntoView({ block: 'center' });
  target?.focus();
}

/** The pairing or re-admission "Vault ready" opened: its first control, or Devices if blocked. */
function focusField(testId: string): void {
  const target = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!target) {
    focusPage();
    return;
  }
  target.scrollIntoView({ block: 'center' });
  target.focus();
}

function PasskeySettings({
  controller,
  session,
  focus,
}: {
  readonly controller: VaultController;
  readonly session: VaultSession;
  readonly focus: boolean;
}) {
  const m = useLanguage().messages;
  const [supported, setSupported] = useState<boolean>();
  const [password, setPassword] = useState('');
  const [state, setState] = useState<PasskeyState>({ kind: 'idle' });
  useEffect(() => {
    let live = true;
    void controller.passkeysSupported().then((s) => {
      if (live) setSupported(s);
    });
    return () => {
      live = false;
    };
  }, [controller]);
  useEffect(() => {
    if (focus && supported !== undefined) focusPage();
  }, [focus, supported]);
  if (supported === undefined) return null;
  const on = session.passkeyCredentialId !== undefined;
  const error = {
    'wrong-password': m.settings.wrong,
    cancelled: m.settings.passkeyCancelled,
    'no-user-verification': m.settings.passkeyNoVerification,
    unavailable: m.settings.passkeyUnavailable,
  };
  return (
    <section className="flex flex-col gap-4" data-section="passkey">
      {!supported && !on ? (
        <p className="text-sm text-muted">{m.settings.passkeyUnsupported}</p>
      ) : null}
      {state.kind === 'done' ? <p role="status">{m.settings.passkeyDone}</p> : null}
      {state.kind === 'done' && state.backupEligible ? (
        <Notice>
          <span data-testid="passkey-synced">{m.settings.passkeySynced}</span>
        </Notice>
      ) : null}
      {state.kind === 'removed' ? <p role="status">{m.settings.passkeyRemoved}</p> : null}
      {state.kind === 'removed-by-hand' ? (
        <p role="status">{m.settings.passkeyRemovedByHand}</p>
      ) : null}
      {on ? (
        <>
          <p className="text-sm">{m.settings.passkeyOn}</p>
          <Button
            variant="quiet"
            className="self-start"
            disabled={state.kind === 'working'}
            onClick={() => {
              setState({ kind: 'working' });
              void controller.removePasskey().then((outcome) => {
                setState({ kind: outcome === 'forgotten' ? 'removed' : 'removed-by-hand' });
              });
            }}
          >
            {m.settings.passkeyRemove}
          </Button>
        </>
      ) : null}
      {!on && supported ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setState({ kind: 'working' });
            // Called in the submit itself: WebAuthn needs the user activation.
            void controller.setUpPasskey(password).then((outcome) => {
              setPassword('');
              setState(
                outcome.kind === 'ok'
                  ? { kind: 'done', backupEligible: outcome.backupEligible }
                  : { kind: outcome.kind },
              );
            });
          }}
        >
          <p className="text-sm">{m.settings.passkeyIntro}</p>
          <Notice>{m.settings.passkeyLostDevice}</Notice>
          <Field
            label={m.settings.passkeyPassword}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setState({ kind: 'idle' });
            }}
            error={state.kind in error ? error[state.kind as keyof typeof error] : undefined}
            data-testid="passkey-password"
          />
          <Button type="submit" disabled={password === '' || state.kind === 'working'}>
            {state.kind === 'working' ? m.settings.passkeySettingUp : m.settings.passkeySetUp}
          </Button>
        </form>
      ) : null}
    </section>
  );
}

/** What a check result says, and whether it is good news (§5.4, D24, D179, D180). */
export function phraseResult(
  m: Messages,
  check: PhraseCheck,
): { readonly ok: boolean; readonly text: string } {
  const s = m.settings;
  switch (check.kind) {
    case 'opens':
      return { ok: true, text: s.recoveryOpens };
    case 'wrong-phrase':
      return { ok: false, text: s.recoveryWrong };
    case 'public-key-mismatch':
      return { ok: false, text: s.recoveryPublicKey };
    case 'master-key-mismatch':
      return { ok: false, text: s.recoveryMasterKey };
    case 'no-envelope':
      return { ok: false, text: s.recoveryNone };
    case 'corrupt-envelope':
      return { ok: false, text: s.recoveryCorrupt };
    case 'locked':
      return { ok: false, text: '' };
    case 'invalid':
      if (check.reason === 'word-count') return { ok: false, text: s.recoveryWordCount };
      if (check.reason === 'checksum') return { ok: false, text: s.recoveryChecksum };
      return {
        ok: false,
        text: format(s.recoveryUnknownWord, { n: String(check.position ?? '') }),
      };
  }
}

/**
 * Check Recovery Phrase (§5.4, D24, D180): the typed words are checked, then dropped from the field
 * at once. A vault without an envelope (D179) or with a corrupt one says so instead. Then
 * regeneration (D185), which also replaces a corrupt envelope.
 */
function RecoveryPhraseSettings({
  controller,
  session,
}: {
  readonly controller: VaultController;
  readonly session: VaultSession;
}) {
  const { messages: m, language } = useLanguage();
  const [input, setInput] = useState('');
  const [check, setCheck] = useState<PhraseCheck>();
  const envelope = controller.recoveryEnvelope();
  const recovery = session.recovery;
  const result = check ? phraseResult(m, check) : undefined;
  const last = session.lastBackupAt;
  return (
    <section className="flex flex-col gap-4" data-section="recovery">
      {envelope === 'none' ? <Notice>{m.settings.recoveryNone}</Notice> : null}
      {envelope === 'corrupt' ? <Notice>{m.settings.recoveryCorrupt}</Notice> : null}
      {envelope === 'held' && recovery ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setCheck(controller.checkRecoveryPhrase(input));
            setInput('');
          }}
        >
          <p className="text-sm" data-testid="recovery-current">
            {format(m.settings.recoveryCreated, {
              date: new Intl.DateTimeFormat(language, { dateStyle: 'long' }).format(
                recovery.phraseCreatedAt,
              ),
              id: phraseLabel(recovery.phraseId),
            })}
          </p>
          {last !== undefined && last < recovery.phraseCreatedAt ? (
            <Notice>
              <span data-testid="recovery-no-backup">{m.settings.recoveryNoBackup}</span>
            </Notice>
          ) : null}
          <p className="text-sm">{m.settings.recoveryIntro}</p>
          <TextArea
            label={m.settings.recoveryInput}
            autoCapitalize="none"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setCheck(undefined);
            }}
            data-testid="check-phrase"
          />
          <Button type="submit" disabled={input.trim() === ''}>
            {m.settings.recoveryCheck}
          </Button>
          {result?.ok ? <p role="status">{result.text}</p> : null}
          {result && !result.ok && result.text !== '' ? (
            <p role="alert" className="text-sm text-danger">
              {result.text}
            </p>
          ) : null}
        </form>
      ) : null}
      <RegeneratePhrase controller={controller} session={session} />
    </section>
  );
}

function hex(id: Uint8Array): string {
  return Array.from(id, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Renames a Device record, this device's own included (D118); no password, as a retirement. */
function DeviceNameForm({
  controller,
  deviceId,
  initial,
  onDone,
}: {
  readonly controller: VaultController;
  readonly deviceId: Uint8Array;
  readonly initial: string;
  readonly onDone: () => void;
}) {
  const { messages: m } = useLanguage();
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string>();
  const [failure, setFailure] = useState<string>();
  return (
    <form
      noValidate
      className="flex w-full flex-col gap-2"
      data-testid="device-rename-form"
      onSubmit={(e) => {
        e.preventDefault();
        const result = folderNameOf(name, DISPLAY_NAME_MAX);
        if (!result.ok) {
          setError(
            result.error === 'required'
              ? m.settings.devicesNameRequired
              : result.error === 'too-long'
                ? m.settings.devicesNameTooLong
                : m.settings.devicesNameSingleLine,
          );
          return;
        }
        void controller.renameDevice(deviceId, result.name).then((outcome) => {
          if (outcome === 'ok' || outcome === 'locked') onDone();
          else if (outcome === 'refused') setFailure(m.settings.devicesRenameRefused);
          else setFailure(m.settings.devicesRenameBlocked);
        });
      }}
    >
      <Field
        label={m.settings.devicesName}
        value={name}
        error={error}
        autoFocus
        onChange={(e) => {
          setName(e.target.value);
          setError(undefined);
          setFailure(undefined);
        }}
        data-testid="device-name"
      />
      {failure ? (
        <p role="alert" className="text-sm text-danger">
          {failure}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit">{m.settings.devicesNameSave}</Button>
        <Button variant="quiet" onClick={onDone}>
          {m.settings.devicesRetireCancel}
        </Button>
      </div>
    </form>
  );
}

type RetireState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'confirm' | 'working' | 'done'; readonly id: string; readonly name: string }
  | { readonly kind: 'refused' };

/**
 * Devices (§8.4, D30, D34, D119, D186, D203): the non-retired Device records, this device's first,
 * with the last completed sync with each other one and the pairings not completed, the count of
 * retired ones, and pairing a new device. A registered device, not retired, offers to sync with
 * each other one (§9.1, D113, D216). An unregistered device is told to get re-admitted; the only device, to
 * make a backup and pair another. Retiring another device asks for a confirmation that states it
 * cannot be undone, is not revocation, and points to re-founding; no password (D186).
 */
function DeviceSettings({
  controller,
  session,
  open,
}: {
  readonly controller: VaultController;
  readonly session: VaultSession;
  /** Opened from "Vault ready": the pairing or the re-admission starts open (D234). */
  readonly open?: 'pair' | 'readmit' | undefined;
}) {
  const { messages: m, language } = useLanguage();
  const [retire, setRetire] = useState<RetireState>({ kind: 'idle' });
  const [renaming, setRenaming] = useState<string>();
  // A live sync outlives this screen: back in it, its panel shows again (D225).
  const [syncWith, setSyncWith] = useState<{ id: string; purpose: SyncPurpose } | undefined>(() => {
    const peer = controller.syncPeer;
    return peer ? { id: hex(peer.deviceId), purpose: 'sync' } : undefined;
  });
  // The open sync on its peer's row, and its dates once it commits (D226).
  const stage = useSyncExternalStore(controller.subscribe, () => controller.sync);
  const syncing = useSyncExternalStore(controller.subscribe, () => controller.syncPeer);
  const devices = devicesOf(session);
  const { syncs } = devices;
  const isPeer = (d: { deviceId: Uint8Array }) => hex(d.deviceId) === syncWith?.id;
  // A sync's peer retired during it stays found, so the sync shows why it ended (D220).
  const peer =
    syncWith?.purpose === 'retirement'
      ? devices.retired.find(isPeer)
      : (devices.listed.find((d) => !d.own && isPeer(d)) ?? devices.retired.find(isPeer));
  const date = new Intl.DateTimeFormat(language, { dateStyle: 'long' });
  // Two syncs on one day are told apart, as the last backup is (D226).
  const synced = new Intl.DateTimeFormat(language, { dateStyle: 'long', timeStyle: 'short' });
  const state = peerSyncState(stage);
  return (
    <section className="flex flex-col gap-4" data-testid="devices" data-section="devices">
      {devices.advice === 'readmit' ? (
        <Notice>
          <span data-testid="devices-readmit">{m.settings.devicesReadmit}</span>
        </Notice>
      ) : null}
      {devices.advice === 'only-device' ? (
        <Notice>
          <span data-testid="devices-only">{m.settings.devicesOnly}</span>
        </Notice>
      ) : null}
      <ul className="divide-y divide-line rounded-card border border-line bg-raised">
        {devices.listed.map((d) => {
          const id = hex(d.deviceId);
          const name = d.device.displayName;
          return (
            <li
              key={id}
              className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm"
              data-testid="device"
            >
              <span className="flex flex-col">
                <span className="font-medium">
                  {d.own ? format(m.settings.devicesThis, { name }) : name}
                </span>
                <span className="text-muted">
                  {format(m.settings.devicesRegistered, {
                    date: date.format(Number(d.device.registeredAt)),
                  })}
                </span>
                {d.own ? null : (
                  <span className="text-muted" data-testid="device-last-sync">
                    {d.lastSyncAt === undefined
                      ? m.settings.devicesNeverSynced
                      : format(m.settings.devicesLastSync, { date: synced.format(d.lastSyncAt) })}
                  </span>
                )}
                {state && syncing && !d.own && hex(syncing.deviceId) === id ? (
                  <span role="status" data-testid="device-sync-state" data-state={state}>
                    {state === 'live' ? m.settings.devicesLive : m.settings.devicesSyncing}
                  </span>
                ) : null}
                {d.pending ? (
                  <span className="text-warning" data-testid="device-pending">
                    {m.settings.devicesPending}
                  </span>
                ) : null}
              </span>
              {d.own || !syncs ? null : (
                <Button
                  variant="quiet"
                  onClick={() => {
                    setSyncWith({ id, purpose: 'sync' });
                  }}
                  data-testid="device-sync"
                >
                  {m.sync.start}
                </Button>
              )}
              <Button
                variant="quiet"
                onClick={() => {
                  setRenaming(id);
                }}
                data-testid="device-rename"
              >
                {m.settings.devicesRename}
              </Button>
              {d.own ? null : (
                <Button
                  variant="quiet"
                  disabled={retire.kind === 'working'}
                  onClick={() => {
                    setRetire({ kind: 'confirm', id, name });
                  }}
                  data-testid="device-retire"
                >
                  {m.settings.devicesRetire}
                </Button>
              )}
              {renaming === id ? (
                <DeviceNameForm
                  key={id}
                  controller={controller}
                  deviceId={d.deviceId}
                  initial={name}
                  onDone={() => {
                    setRenaming(undefined);
                  }}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
      {devices.retiredCount > 0 ? (
        <p className="text-sm text-muted" data-testid="devices-retired-count">
          {format(m.settings.devicesRetiredCount, { n: String(devices.retiredCount) })}
        </p>
      ) : null}
      {syncs && devices.retired.length > 0 ? (
        <details className="text-sm" data-testid="retired-devices">
          <summary className="cursor-pointer">{m.settings.devicesRetiredList}</summary>
          <p className="text-muted">{m.settings.devicesRetiredNotify}</p>
          <ul className="mt-2 flex flex-col gap-2">
            {devices.retired.map((d) => {
              const id = hex(d.deviceId);
              const name = d.device.displayName;
              return (
                <li
                  key={id}
                  className="flex flex-wrap items-center justify-between gap-2"
                  data-testid="retired-device"
                >
                  <span className="font-medium">{name}</span>
                  <Button
                    variant="quiet"
                    onClick={() => {
                      setSyncWith({ id, purpose: 'retirement' });
                    }}
                    data-testid="device-notify"
                  >
                    {format(m.settings.devicesNotify, { name })}
                  </Button>
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
      {retire.kind === 'confirm' || retire.kind === 'working' ? (
        <ConfirmDialog
          data-testid="retire-confirm"
          confirm={format(m.settings.devicesRetireConfirm, { name: retire.name })}
          cancel={m.settings.devicesRetireCancel}
          busy={retire.kind === 'working'}
          onConfirm={() => {
            const target = devices.listed.find((d) => hex(d.deviceId) === retire.id);
            if (!target) return;
            setRetire({ ...retire, kind: 'working' });
            void controller.retireDevice(target.deviceId).then((outcome) => {
              if (outcome === 'ok') setRetire({ ...retire, kind: 'done' });
              else if (outcome === 'refused') setRetire({ kind: 'refused' });
              // Locked meanwhile: this screen is gone, and nothing changed.
              else setRetire({ kind: 'idle' });
            });
          }}
          onCancel={() => {
            setRetire({ kind: 'idle' });
          }}
        >
          {devices.listed.some((d) => d.pending && hex(d.deviceId) === retire.id) ? (
            <Notice>{format(m.settings.devicesPendingRetire, { name: retire.name })}</Notice>
          ) : null}
          <Notice>{format(m.settings.devicesRetireWarning, { name: retire.name })}</Notice>
        </ConfirmDialog>
      ) : null}
      {retire.kind === 'done' ? (
        <p role="status">{format(m.settings.devicesRetired, { name: retire.name })}</p>
      ) : null}
      {retire.kind === 'refused' ? (
        <p role="alert" className="text-sm text-danger">
          {m.settings.devicesRefused}
        </p>
      ) : null}
      {peer && syncWith ? (
        // Kept while this device turns retired during it, so it shows why the sync ended (D219).
        <SyncDevice
          key={`${syncWith.purpose}:${hex(peer.deviceId)}`}
          controller={controller}
          session={session}
          peer={{ deviceId: peer.deviceId, name: peer.device.displayName }}
          purpose={syncWith.purpose}
          onClose={() => {
            setSyncWith(undefined);
          }}
        />
      ) : null}
      <InviteDevice controller={controller} session={session} open={open === 'pair'} />
      <ReadmitDevice controller={controller} session={session} open={open === 'readmit'} />
    </section>
  );
}

/** The name of a record type for the UI, by its registry number (crypto-spec.md §9.1). */
export function recordTypeName(m: Messages, recordType: number): string {
  const names = m.settings.recordTypes;
  const entry = Object.entries(RecordType).find(([, value]) => value === recordType);
  return entry ? names[entry[0] as keyof typeof names] : String(recordType);
}

/** What an export that made no file says (backup-format.md §8, D64, D179, D181). */
export function exportError(m: Messages, outcome: BackupExport): string | undefined {
  const s = m.settings;
  switch (outcome.kind) {
    case 'ok':
    case 'locked':
      return undefined;
    case 'wrong-password':
      return s.backupWrong;
    case 'no-envelope':
      return s.backupNone;
    case 'cancelled':
      return s.backupPasskeyCancelled;
    case 'rejected':
      return s.backupPasskeyRejected;
    case 'no-user-verification':
      return s.backupPasskeyNoVerification;
    case 'unavailable':
      return s.backupPasskeyUnavailable;
    case 'corrupt-record':
      return format(s.backupCorrupt, {
        type: recordTypeName(m, outcome.recordType),
        id: outcome.recordId,
      });
  }
}

/**
 * Export (§10, D36, D134, D155, D181): the Recovery Phrase always opens the file; an export
 * password is optional, with the warning that it yields the Master Key. The local password, or the
 * passkey, is asked for again. Shows the last backup made on this device (§13.4).
 */
/** The peers of the incomplete-backup warning, each labelled by its device name, or its ID (D115). */
export function incompleteBackupPeers(session: Parameters<typeof rejectedPeersOf>[0]) {
  return rejectedPeersOf(session).map((p) => ({
    ...p,
    id: hex(p.deviceId),
    label: p.name ?? recordIdPrefix(p.deviceId),
  }));
}

/**
 * The export warning while peers' records were rejected for their format or type, naming the peers,
 * each dismissable after a confirmation, for a device lost or retired (D68, D115, D227).
 */
function IncompleteBackup({
  controller,
  session,
}: {
  readonly controller: VaultController;
  readonly session: VaultSession;
}) {
  const { messages: m } = useLanguage();
  const [confirm, setConfirm] = useState<string>();
  const [working, setWorking] = useState(false);
  const peers = incompleteBackupPeers(session);
  const asked = peers.find((p) => p.id === confirm);
  return (
    <div className="flex flex-col gap-2" data-testid="backup-incomplete">
      <Notice>
        {format(m.settings.backupIncomplete, { names: peers.map((p) => p.label).join(', ') })}
      </Notice>
      {asked ? (
        <ConfirmDialog
          data-testid="backup-incomplete-confirm"
          confirm={format(m.settings.backupIncompleteConfirm, { name: asked.label })}
          cancel={m.settings.backupIncompleteCancel}
          busy={working}
          onConfirm={() => {
            setWorking(true);
            void controller.dismissRejectedPeer(asked.deviceId).then(() => {
              setWorking(false);
              setConfirm(undefined);
            });
          }}
          onCancel={() => {
            setConfirm(undefined);
          }}
        >
          <Notice>{format(m.settings.backupIncompleteWarning, { name: asked.label })}</Notice>
        </ConfirmDialog>
      ) : null}
      {asked ? null : (
        <div className="flex flex-wrap gap-2">
          {peers.map((p) => (
            <Button
              key={p.id}
              variant="quiet"
              onClick={() => {
                setConfirm(p.id);
              }}
              data-testid="backup-incomplete-dismiss"
            >
              {format(m.settings.backupIncompleteDismiss, { name: p.label })}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

function BackupSettings({
  controller,
  session,
}: {
  readonly controller: VaultController;
  readonly session: VaultSession;
}) {
  const { messages: m, language } = useLanguage();
  const [protect, setProtect] = useState(false);
  const [exportPassword, setExportPassword] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [working, setWorking] = useState(false);
  const [outcome, setOutcome] = useState<BackupExport>();
  const [form, setForm] = useState(0);
  const onExportPassword = useCallback((p: string | null) => {
    setExportPassword(p);
  }, []);
  if (!session.recovery) {
    return <Notice>{m.settings.backupNone}</Notice>;
  }
  const last = session.lastBackupAt;
  const { phraseId, phraseCreatedAt } = session.recovery;
  const run = (auth: ExportAuth) => {
    setWorking(true);
    setOutcome(undefined);
    // Called in the click itself: a passkey assertion needs the user activation.
    void controller
      .exportBackup(auth, protect ? (exportPassword ?? undefined) : undefined)
      .then((result) => {
        setPassword('');
        setWorking(false);
        setOutcome(result);
        if (result.kind === 'ok') {
          download(result.bytes, result.name);
          setProtect(false);
          setExportPassword(null);
          setForm((f) => f + 1);
        }
      });
  };
  const ready = !working && (!protect || exportPassword !== null);
  const error = outcome ? exportError(m, outcome) : undefined;
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        run({ kind: 'password', password });
      }}
    >
      <p className="text-sm">{m.settings.backupIntro}</p>
      <p className="text-sm" data-testid="last-backup">
        {last === undefined
          ? m.settings.backupNever
          : format(m.settings.backupLast, {
              date: new Intl.DateTimeFormat(language, {
                dateStyle: 'long',
                timeStyle: 'short',
              }).format(last),
            })}
      </p>
      {session.backupMayBeIncomplete ? (
        <IncompleteBackup controller={controller} session={session} />
      ) : null}
      <label className={`${TARGET} flex items-center gap-2 text-sm`}>
        <input
          type="checkbox"
          checked={protect}
          onChange={(e) => {
            setProtect(e.target.checked);
          }}
          data-testid="backup-protect"
        />
        {m.settings.backupProtect}
      </label>
      {protect ? (
        <>
          <Notice>
            <span data-testid="backup-master-key">{m.settings.backupMasterKey}</span>
          </Notice>
          <ExportPassword key={form} onChange={onExportPassword} />
        </>
      ) : null}
      <p className="text-sm">{m.settings.backupAuthIntro}</p>
      <Field
        label={m.settings.backupAuth}
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => {
          setPassword(e.target.value);
          setOutcome(undefined);
        }}
        data-testid="backup-password"
      />
      {session.preferences.hiddenLockSeconds === 0 ? (
        <p className="text-sm text-muted">{m.settings.backupHidden}</p>
      ) : null}
      <Button type="submit" disabled={!ready || password === ''}>
        {working ? m.settings.backupExporting : m.settings.backupExport}
      </Button>
      {controller.hasPasskey ? (
        <Button
          variant="quiet"
          className="self-start"
          disabled={!ready}
          onClick={() => {
            run({ kind: 'passkey' });
          }}
        >
          {m.settings.backupPasskey}
        </Button>
      ) : null}
      {outcome?.kind === 'ok' ? (
        <p role="status">
          {format(m.settings.backupDone, {
            name: outcome.name,
            id: phraseLabel(phraseId),
            date: new Intl.DateTimeFormat(language, { dateStyle: 'long' }).format(phraseCreatedAt),
          })}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </form>
  );
}
