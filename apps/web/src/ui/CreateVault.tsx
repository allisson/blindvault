import { useCallback, useEffect, useRef, useState } from 'react';

import { type VaultController } from '../app/controller';
import { deviceName } from '../app/device-name';
import { drawPositions } from '../app/phrase-check';
import { useMessages } from '../i18n/context';
import { Button, Card } from './components';
import { NewPassword } from './NewPassword';
import { ConfirmWords, PhraseWords } from './PhraseSteps';

// Create vault → Recovery Phrase → confirmation → local password (§13.3, D179). Nothing is written
// before the password step; the words live only in this component's state until confirmed.

type Step =
  | { readonly kind: 'phrase'; readonly words: readonly string[]; readonly wrong: boolean }
  | {
      readonly kind: 'confirm';
      readonly words: readonly string[];
      readonly positions: readonly number[];
    }
  | { readonly kind: 'password' };

export function CreateVault({
  controller,
  working,
}: {
  readonly controller: VaultController;
  readonly working: boolean;
}) {
  const m = useMessages();
  const [step, setStep] = useState<Step | null>(null);
  const restart = useCallback(() => {
    const words = controller.newRecoveryPhrase();
    setStep(words ? { kind: 'phrase', words: words.split(' '), wrong: false } : null);
  }, [controller]);
  useEffect(restart, [restart]);
  // A creation that fails or is locked drops its phrase: start again with a new one.
  const wasWorking = useRef(false);
  useEffect(() => {
    if (wasWorking.current && !working) restart();
    wasWorking.current = working;
  }, [working, restart]);

  if (!step) return null;
  switch (step.kind) {
    case 'phrase':
      return (
        <Card title={m.create.title}>
          <p className="text-sm">{m.create.intro}</p>
          <PhraseWords
            title={m.create.phraseTitle}
            words={step.words}
            wrong={step.wrong}
            onWritten={() => {
              setStep({ kind: 'confirm', words: step.words, positions: drawPositions() });
            }}
          />
        </Card>
      );
    case 'confirm':
      return (
        <Card title={m.create.confirmTitle}>
          <ConfirmWords
            words={step.words}
            positions={step.positions}
            onConfirmed={() => {
              // The words are no longer needed: only the controller's entropy remains.
              setStep({ kind: 'password' });
            }}
            onWrong={() => {
              setStep({ kind: 'phrase', words: step.words, wrong: true });
            }}
          />
        </Card>
      );
    case 'password':
      return <SetPassword controller={controller} working={working} />;
  }
}

function SetPassword({
  controller,
  working,
}: {
  readonly controller: VaultController;
  readonly working: boolean;
}) {
  const m = useMessages();
  const [password, setPassword] = useState<string | null>(null);
  const onChange = useCallback((p: string | null) => {
    setPassword(p);
  }, []);
  return (
    <Card title={m.create.title}>
      <p className="text-sm">{m.create.passwordIntro}</p>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (password) void controller.create(password, deviceName(navigator.userAgent));
        }}
      >
        <NewPassword
          label={m.create.password}
          confirmLabel={m.create.confirm}
          onChange={onChange}
        />
        <Button type="submit" disabled={!password || working}>
          {working ? m.create.working : m.create.submit}
        </Button>
      </form>
    </Card>
  );
}
