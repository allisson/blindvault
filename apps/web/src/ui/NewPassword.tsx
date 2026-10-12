import { useEffect, useState } from 'react';

import { type Strength, estimator } from '../app/strength';
import { useLanguage } from '../i18n/context';
import { Field } from './components';

/** A new local password and its confirmation; `onChange` gets it only once it is acceptable (D71). */
export function NewPassword({
  label,
  confirmLabel,
  onChange,
}: {
  readonly label: string;
  readonly confirmLabel: string;
  readonly onChange: (password: string | null) => void;
}) {
  const { language, messages: m } = useLanguage();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [strength, setStrength] = useState<Strength | null>(null);

  useEffect(() => {
    let current = true;
    if (password === '') {
      setStrength(null);
      return;
    }
    void estimator(language).then((estimate) => {
      if (current) setStrength(estimate(password));
    });
    return () => {
      current = false;
    };
  }, [password, language]);

  const acceptable = strength?.acceptable === true;
  const matches = password === confirm;
  useEffect(() => {
    onChange(acceptable && matches && password !== '' ? password : null);
  }, [acceptable, matches, password, onChange]);

  return (
    <>
      <Field
        label={label}
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={(e) => {
          setPassword(e.target.value);
        }}
        error={strength && !acceptable ? strength.warning || m.create.weak : undefined}
        hint={acceptable ? m.create.strong : undefined}
        data-testid="new-password"
      />
      <div aria-hidden className="flex gap-1" data-testid="strength">
        {[1, 2, 3, 4].map((level) => (
          <span
            key={level}
            className={`h-1.5 flex-1 rounded-full ${
              (strength?.score ?? 0) >= level
                ? acceptable
                  ? 'bg-emerald-600'
                  : 'bg-amber-500'
                : 'bg-zinc-200 dark:bg-zinc-700'
            }`}
          />
        ))}
      </div>
      <Field
        label={confirmLabel}
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => {
          setConfirm(e.target.value);
        }}
        error={confirm !== '' && !matches ? m.create.mismatch : undefined}
        data-testid="confirm-password"
      />
    </>
  );
}
