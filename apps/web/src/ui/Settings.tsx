import { type Preferences, type VaultSession } from '@blindvault/vault';
import { useCallback, useEffect, useState } from 'react';

import { type PasskeySetup, type VaultController } from '../app/controller';
import { useLanguage } from '../i18n/context';
import { LANGUAGES } from '../i18n/messages';
import { Button, Field, Notice } from './components';
import { NewPassword } from './NewPassword';

export function Settings({
  controller,
  session,
}: {
  readonly controller: VaultController;
  readonly session: VaultSession;
}) {
  const { messages: m, language, setLanguage } = useLanguage();
  return (
    <div className="flex max-w-md flex-col gap-8 p-4">
      <h1 className="text-xl font-semibold">{m.settings.title}</h1>
      <ChangePassword controller={controller} />
      <PasskeySettings controller={controller} session={session} />
      <LockSettings controller={controller} preferences={session.preferences} />
      <label className="flex flex-col gap-1 text-sm font-medium">
        {m.settings.language}
        <select
          className="min-h-10 rounded-md border border-zinc-300 bg-white px-3 dark:border-zinc-700 dark:bg-zinc-900"
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
function PasskeySettings({
  controller,
  session,
}: {
  readonly controller: VaultController;
  readonly session: VaultSession;
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
  if (supported === undefined) return null;
  const on = session.passkeyCredentialId !== undefined;
  const error = {
    'wrong-password': m.settings.wrong,
    cancelled: m.settings.passkeyCancelled,
    'no-user-verification': m.settings.passkeyNoVerification,
    unavailable: m.settings.passkeyUnavailable,
  };
  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-semibold">{m.settings.passkey}</h2>
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
