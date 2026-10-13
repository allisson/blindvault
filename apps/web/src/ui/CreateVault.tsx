import { useCallback, useEffect, useRef, useState } from 'react';

import { type VaultController } from '../app/controller';
import { deviceName } from '../app/device-name';
import { drawPositions, wordMatches } from '../app/phrase-check';
import { useMessages } from '../i18n/context';
import { format } from '../i18n/messages';
import { Button, Card, Field } from './components';
import { NewPassword } from './NewPassword';

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
        <ShowPhrase
          words={step.words}
          wrong={step.wrong}
          onWritten={() => {
            setStep({ kind: 'confirm', words: step.words, positions: drawPositions() });
          }}
        />
      );
    case 'confirm':
      return (
        <ConfirmPhrase
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
      );
    case 'password':
      return <SetPassword controller={controller} working={working} />;
  }
}

function ShowPhrase({
  words,
  wrong,
  onWritten,
}: {
  readonly words: readonly string[];
  readonly wrong: boolean;
  readonly onWritten: () => void;
}) {
  const m = useMessages();
  return (
    <Card title={m.create.title}>
      <p className="text-sm">{m.create.intro}</p>
      <h2 className="text-lg font-semibold">{m.create.phraseTitle}</h2>
      {wrong ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {m.create.confirmWrong}
        </p>
      ) : null}
      <p className="text-sm">{m.create.phraseIntro}</p>
      {/* No copy or download: the clipboard and downloaded files are outside the app (D179). */}
      <ol
        data-testid="recovery-phrase"
        className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-zinc-100 p-3 font-mono text-sm sm:grid-cols-3 dark:bg-zinc-800"
      >
        {words.map((word, i) => (
          <li key={i} className="flex gap-2">
            <span className="w-6 text-right text-zinc-500">{i + 1}.</span>
            <span data-testid={`phrase-word-${String(i + 1)}`}>{word}</span>
          </li>
        ))}
      </ol>
      <p className="text-sm">{m.create.phraseOnce}</p>
      <p className="text-sm text-amber-800 dark:text-amber-300">{m.create.phraseNoPhoto}</p>
      <Button onClick={onWritten}>{m.create.phraseWritten}</Button>
    </Card>
  );
}

function ConfirmPhrase({
  words,
  positions,
  onConfirmed,
  onWrong,
}: {
  readonly words: readonly string[];
  readonly positions: readonly number[];
  readonly onConfirmed: () => void;
  readonly onWrong: () => void;
}) {
  const m = useMessages();
  const [typed, setTyped] = useState<readonly string[]>(positions.map(() => ''));
  return (
    <Card title={m.create.confirmTitle}>
      <p className="text-sm">{m.create.confirmIntro}</p>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          const right = positions.every((p, i) => wordMatches(typed[i] ?? '', words[p - 1] ?? ''));
          if (right) onConfirmed();
          else onWrong();
        }}
      >
        {positions.map((p, i) => (
          <Field
            key={p}
            label={format(m.create.word, { n: String(p) })}
            autoCapitalize="none"
            autoFocus={i === 0}
            value={typed[i] ?? ''}
            onChange={(e) => {
              const next = [...typed];
              next[i] = e.target.value;
              setTyped(next);
            }}
            data-testid={`confirm-word-${String(p)}`}
          />
        ))}
        <Button type="submit" disabled={typed.some((t) => t.trim() === '')}>
          {m.create.confirmSubmit}
        </Button>
      </form>
    </Card>
  );
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
