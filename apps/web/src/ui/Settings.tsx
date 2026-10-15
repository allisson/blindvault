import { RecordType } from '@blindvault/crypto';
import { type Preferences, type VaultSession } from '@blindvault/vault';
import { useCallback, useEffect, useState } from 'react';

import { download, phraseLabel } from '../app/backup-file';
import { devicesOf, eraseAdvice } from '../app/devices';
import { type Navigation, type SettingsFocus } from '../app/nav';
import {
  type BackupExport,
  type ExportAuth,
  type PasskeySetup,
  type PhraseCheck,
  type VaultController,
} from '../app/controller';
import { useLanguage } from '../i18n/context';
import { LANGUAGES, type Messages, format } from '../i18n/messages';
import { AboutBuild } from './About';
import { Button, Field, INPUT, Notice, TARGET, TextArea } from './components';
import { EraseVault } from './EraseVault';
import { ExportPassword } from './ExportPassword';
import { MergeBackup } from './MergeBackup';
import { NewPassword } from './NewPassword';
import { InviteDevice } from './Pairing';
import { RefoundVault } from './RefoundVault';
import { RegeneratePhrase, focusBackup } from './RegeneratePhrase';
import { DeviceStorage } from './StorageState';

export function Settings({
  controller,
  session,
  nav,
  focus,
}: {
  readonly controller: VaultController;
  readonly session: VaultSession;
  readonly nav: Navigation;
  /** Opened from the backup reminder (D188) or "Vault ready" (D198): where the cursor goes. */
  readonly focus?: SettingsFocus | undefined;
}) {
  const { messages: m, language, setLanguage } = useLanguage();
  useEffect(() => {
    if (focus === 'backup') focusBackup();
    // The passkey section shows once support is known: it focuses itself.
    else if (focus === 'recovery' || focus === 'devices') focusSection(focus);
  }, [focus]);
  return (
    <div className="flex max-w-md flex-col gap-8 p-4">
      <h1 className="text-xl font-semibold">{m.settings.title}</h1>
      <DeviceStorage controller={controller} session={session} />
      <BackupSettings controller={controller} session={session} />
      <MergeBackup controller={controller} session={session} />
      <RecoveryPhraseSettings controller={controller} session={session} />
      <DeviceSettings controller={controller} session={session} />
      <ChangePassword controller={controller} />
      <PasskeySettings controller={controller} session={session} focus={focus === 'passkey'} />
      <LockSettings controller={controller} preferences={session.preferences} />
      <RefoundVault controller={controller} session={session} nav={nav} />
      <EraseSettings controller={controller} session={session} />
      <section className="flex flex-col gap-4">
        <h2 className="font-semibold">{m.about.title}</h2>
        <AboutBuild />
      </section>
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
          <option value="en">English</option>
          <option value="pt-BR">Português (Brasil)</option>
        </select>
      </label>
    </div>
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
      <h2 className="font-semibold">{m.settings.password}</h2>
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
      <h2 className="font-semibold">{m.settings.locking}</h2>
      {field('autoLockMinutes', m.settings.autoLock, 1, 60)}
      {field('hiddenLockSeconds', m.settings.hiddenLock, 0, 900)}
      {values.hiddenLockSeconds === '0' ? (
        <p className="text-sm text-zinc-500">{m.settings.hiddenImmediate}</p>
      ) : null}
      {field('clipboardClearSeconds', m.settings.clipboard, 10, 120)}
      <Button type="submit">{m.settings.save}</Button>
      {state === 'saved' ? <p role="status">{m.settings.saved}</p> : null}
      {state === 'invalid' ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
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
  const [open, setOpen] = useState(false);
  return (
    <section className="flex flex-col gap-4" data-section="erase">
      <h2 className="font-semibold">{m.erase.title}</h2>
      <p className="text-sm">{m.erase.intro}</p>
      {open ? (
        <EraseVault
          controller={controller}
          advice={eraseAdvice(devicesOf(session))}
          onBackup={focusBackup}
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

/** Scrolls to a section and puts the cursor in its first field, or on its heading (D198). */
function focusSection(name: SettingsFocus): void {
  const section = document.querySelector(`[data-section="${name}"]`);
  const target =
    section?.querySelector<HTMLElement>('input, textarea') ?? section?.querySelector('h2');
  target?.scrollIntoView({ block: 'center' });
  target?.focus();
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
    if (focus && supported !== undefined) focusSection('passkey');
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
      <h2 tabIndex={-1} className="font-semibold">
        {m.settings.passkey}
      </h2>
      {!supported && !on ? (
        <p className="text-sm text-zinc-500">{m.settings.passkeyUnsupported}</p>
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
function phraseResult(
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
      <h2 tabIndex={-1} className="font-semibold">
        {m.settings.recovery}
      </h2>
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
            <p role="alert" className="text-sm text-red-700 dark:text-red-400">
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

type RetireState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'confirm' | 'working' | 'done'; readonly id: string; readonly name: string }
  | { readonly kind: 'refused' };

/**
 * Devices (§8.4, D30, D34, D119, D186, D203): the non-retired Device records, this device's first,
 * with the last completed sync with each other one and the pairings not completed, the count of
 * retired ones, and pairing a new device. An unregistered device is told to get re-admitted; the only device, to
 * make a backup and pair another. Retiring another device asks for a confirmation that states it
 * cannot be undone, is not revocation, and points to re-founding; no password (D186).
 */
function DeviceSettings({
  controller,
  session,
}: {
  readonly controller: VaultController;
  readonly session: VaultSession;
}) {
  const { messages: m, language } = useLanguage();
  const [retire, setRetire] = useState<RetireState>({ kind: 'idle' });
  const devices = devicesOf(session);
  const date = new Intl.DateTimeFormat(language, { dateStyle: 'long' });
  return (
    <section className="flex flex-col gap-4" data-testid="devices" data-section="devices">
      <h2 tabIndex={-1} className="font-semibold">
        {m.settings.devices}
      </h2>
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
      <ul className="flex flex-col gap-2">
        {devices.listed.map((d) => {
          const id = hex(d.deviceId);
          const name = d.device.displayName;
          return (
            <li
              key={id}
              className="flex flex-wrap items-center justify-between gap-2 text-sm"
              data-testid="device"
            >
              <span className="flex flex-col">
                <span className="font-medium">
                  {d.own ? format(m.settings.devicesThis, { name }) : name}
                </span>
                <span className="text-zinc-500">
                  {format(m.settings.devicesRegistered, {
                    date: date.format(Number(d.device.registeredAt)),
                  })}
                </span>
                {d.own ? null : (
                  <span className="text-zinc-500" data-testid="device-last-sync">
                    {d.lastSyncAt === undefined
                      ? m.settings.devicesNeverSynced
                      : format(m.settings.devicesLastSync, { date: date.format(d.lastSyncAt) })}
                  </span>
                )}
                {d.pending ? (
                  <span className="text-amber-700 dark:text-amber-400" data-testid="device-pending">
                    {m.settings.devicesPending}
                  </span>
                ) : null}
              </span>
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
            </li>
          );
        })}
      </ul>
      {devices.retiredCount > 0 ? (
        <p className="text-sm text-zinc-500" data-testid="devices-retired-count">
          {format(m.settings.devicesRetiredCount, { n: String(devices.retiredCount) })}
        </p>
      ) : null}
      {retire.kind === 'confirm' || retire.kind === 'working' ? (
        <div className="flex flex-col gap-2" data-testid="retire-confirm">
          {devices.listed.some((d) => d.pending && hex(d.deviceId) === retire.id) ? (
            <Notice>{format(m.settings.devicesPendingRetire, { name: retire.name })}</Notice>
          ) : null}
          <Notice>{format(m.settings.devicesRetireWarning, { name: retire.name })}</Notice>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={retire.kind === 'working'}
              onClick={() => {
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
            >
              {format(m.settings.devicesRetireConfirm, { name: retire.name })}
            </Button>
            <Button
              variant="quiet"
              disabled={retire.kind === 'working'}
              onClick={() => {
                setRetire({ kind: 'idle' });
              }}
            >
              {m.settings.devicesRetireCancel}
            </Button>
          </div>
        </div>
      ) : null}
      {retire.kind === 'done' ? (
        <p role="status">{format(m.settings.devicesRetired, { name: retire.name })}</p>
      ) : null}
      {retire.kind === 'refused' ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {m.settings.devicesRefused}
        </p>
      ) : null}
      <InviteDevice controller={controller} session={session} />
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
function exportError(m: Messages, outcome: BackupExport): string | undefined {
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
    return (
      <section className="flex flex-col gap-4">
        <h2 className="font-semibold">{m.settings.backup}</h2>
        <Notice>{m.settings.backupNone}</Notice>
      </section>
    );
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
      <h2 className="font-semibold">{m.settings.backup}</h2>
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
      {session.backupMayBeIncomplete ? <Notice>{m.settings.backupIncomplete}</Notice> : null}
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
        <p className="text-sm text-zinc-500">{m.settings.backupHidden}</p>
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
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </form>
  );
}
