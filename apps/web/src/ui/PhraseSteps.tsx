import { useState } from 'react';

import { wordMatches } from '../app/phrase-check';
import { useMessages } from '../i18n/context';
import { format } from '../i18n/messages';
import { Button, Field } from './components';

// The Recovery Phrase shown once, then confirmed at three positions drawn at random (§5.4, D179):
// at creation and at regeneration (D185). The words live only in the caller's state.

export function PhraseWords({
  title,
  words,
  wrong,
  onWritten,
}: {
  readonly title: string;
  readonly words: readonly string[];
  readonly wrong: boolean;
  readonly onWritten: () => void;
}) {
  const m = useMessages();
  return (
    <>
      <h2 className="text-lg font-semibold">{title}</h2>
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
    </>
  );
}

export function ConfirmWords({
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
    <>
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
    </>
  );
}
