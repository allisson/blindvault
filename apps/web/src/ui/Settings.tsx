import { type Preferences, type VaultSession } from '@blindvault/vault';
import { useCallback, useState } from 'react';

import { type VaultController } from '../app/controller';
import { useLanguage } from '../i18n/context';
import { LANGUAGES } from '../i18n/messages';
import { Button, Field } from './components';
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
          } else {
            setState('wrong');
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
