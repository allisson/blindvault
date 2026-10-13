import { GENERATOR_LIMITS, type Generated, generatePassphrase } from '@blindvault/crypto';
import { useEffect, useState } from 'react';

import { type ExportStrength, exportStrength } from '../app/strength';
import { useLanguage } from '../i18n/context';
import { Button, Field } from './components';

/**
 * An export password and its confirmation, with a generated 6-word passphrase on offer (D134,
 * D155); `onChange` gets it only once it reaches the export threshold and both fields match. A
 * passphrase taken from the generator is shown, so it can be written down.
 */
export function ExportPassword({
  onChange,
}: {
  readonly onChange: (password: string | null) => void;
}) {
  const { language, messages: m } = useLanguage();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [generated, setGenerated] = useState<Generated>();
  const [strength, setStrength] = useState<ExportStrength | null>(null);

  useEffect(() => {
    let current = true;
    if (password === '') {
      setStrength(null);
      return;
    }
    void exportStrength(language, password, generated).then((s) => {
      if (current) setStrength(s);
    });
    return () => {
      current = false;
    };
  }, [password, generated, language]);

  const acceptable = strength?.acceptable === true;
  const matches = password === confirm;
  useEffect(() => {
    onChange(acceptable && matches && password !== '' ? password : null);
  }, [acceptable, matches, password, onChange]);

  const shown = generated?.value === password;
  return (
    <>
      <Field
        label={m.settings.exportPassword}
        type={shown ? 'text' : 'password'}
        value={password}
        onChange={(e) => {
          setPassword(e.target.value);
        }}
        error={strength && !acceptable ? strength.warning || m.settings.exportWeak : undefined}
        hint={
          acceptable ? (shown ? m.settings.exportGenerated : m.settings.exportStrong) : undefined
        }
        data-testid="export-password"
      />
      <Button
        variant="quiet"
        className="self-start"
        onClick={() => {
          const next = generatePassphrase(GENERATOR_LIMITS.words.default);
          setGenerated(next);
          setPassword(next.value);
          setConfirm('');
        }}
      >
        {m.settings.exportGenerate}
      </Button>
      <Field
        label={m.settings.exportConfirm}
        type="password"
        value={confirm}
        onChange={(e) => {
          setConfirm(e.target.value);
        }}
        error={confirm !== '' && !matches ? m.create.mismatch : undefined}
        data-testid="export-confirm"
      />
    </>
  );
}
