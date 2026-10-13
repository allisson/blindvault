import { useCallback, useState } from 'react';

import { type PasswordReset, type VaultController } from '../app/controller';
import { useMessages } from '../i18n/context';
import { type Messages, format } from '../i18n/messages';
import { Button, Card, TextArea } from './components';
import { NewPassword } from './NewPassword';

// A forgotten local password reset with the Recovery Phrase (§14, D173, D184): the phrase, then
// the new password. The vault stays locked until the reset commits, and the phrase is checked
// only then, against the Recovery Envelope this device holds.

export function ResetPassword({
  controller,
  working,
  onCancel,
}: {
  readonly controller: VaultController;
  readonly working: boolean;
  readonly onCancel: () => void;
}) {
  const m = useMessages();
  const [words, setWords] = useState('');
  const [step, setStep] = useState<'phrase' | 'password'>('phrase');
  const [error, setError] = useState<string | undefined>();
  const [password, setPassword] = useState<string | null>(null);
  const onChange = useCallback((p: string | null) => {
    setPassword(p);
  }, []);
  return (
    <Card title={m.reset.title}>
      {step === 'phrase' ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError(undefined);
            setStep('password');
          }}
        >
          <p className="text-sm">{m.reset.intro}</p>
          <TextArea
            label={m.restore.phrase}
            hint={m.reset.hint}
            autoCapitalize="none"
            autoFocus
            value={words}
            error={error}
            onChange={(e) => {
              setWords(e.target.value);
            }}
            data-testid="reset-phrase"
          />
          <Button type="submit" disabled={words.trim() === ''}>
            {m.reset.next}
          </Button>
        </form>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!password) return;
            const typed = words;
            // The words leave the field at once, whatever the result.
            setWords('');
            void controller.resetPassword(typed, password).then((outcome) => {
              if (outcome.kind === 'ok') return;
              setError(resetError(m, outcome));
              setStep('phrase');
            });
          }}
        >
          <p className="text-sm">{m.reset.passwordIntro}</p>
          <NewPassword
            label={m.restore.local}
            confirmLabel={m.restore.confirm}
            onChange={onChange}
          />
          <Button type="submit" disabled={!password || working}>
            {working ? m.reset.working : m.reset.submit}
          </Button>
        </form>
      )}
      {working ? null : (
        <Button
          variant="quiet"
          className="self-start"
          onClick={() => {
            setWords('');
            onCancel();
          }}
        >
          {m.restore.cancel}
        </Button>
      )}
    </Card>
  );
}

function resetError(m: Messages, outcome: PasswordReset): string | undefined {
  switch (outcome.kind) {
    case 'ok':
    case 'unavailable':
      return undefined;
    case 'invalid':
      if (outcome.reason === 'word-count') return m.settings.recoveryWordCount;
      if (outcome.reason === 'checksum') return m.settings.recoveryChecksum;
      return format(m.settings.recoveryUnknownWord, { n: String(outcome.position ?? '') });
    case 'wrong-phrase':
      return m.reset.wrongPhrase;
    case 'master-key-mismatch':
      return m.reset.masterKey;
    case 'no-envelope':
      return m.reset.noEnvelope;
    case 'locked':
      return m.reset.locked;
  }
}
