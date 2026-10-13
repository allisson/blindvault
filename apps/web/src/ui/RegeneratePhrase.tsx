import { type RecoveryView, type VaultSession } from '@blindvault/vault';
import { useEffect, useState } from 'react';

import { phraseLabel } from '../app/backup-file';
import { type ExportAuth, type Regeneration, type VaultController } from '../app/controller';
import { drawPositions } from '../app/phrase-check';
import { useLanguage } from '../i18n/context';
import { type Messages, format } from '../i18n/messages';
import { Button, Field, Notice } from './components';
import { ConfirmWords, PhraseWords } from './PhraseSteps';

// Recovery Phrase regeneration (§5.4, D185): warning → new phrase → confirmation → local password
// or passkey → result. Nothing is written before the last step; the inactivity lock pauses while
// the controller holds the phrase (D104), and leaving this screen drops it.

type Step =
  | { readonly kind: 'idle' }
  | { readonly kind: 'warn' }
  | { readonly kind: 'phrase'; readonly words: readonly string[]; readonly wrong: boolean }
  | {
      readonly kind: 'confirm';
      readonly words: readonly string[];
      readonly positions: readonly number[];
    }
  | { readonly kind: 'auth' }
  | { readonly kind: 'done'; readonly recovery: RecoveryView };

/** Scrolls to the export form and puts the cursor in its password field (D185). */
export function focusBackup(): void {
  const field = document.querySelector<HTMLInputElement>('[data-testid="backup-password"]');
  field?.scrollIntoView({ block: 'center' });
  field?.focus();
}

/** What a regeneration that changed nothing says. */
function regenerationError(m: Messages, outcome: Regeneration): string | undefined {
  const s = m.settings;
  switch (outcome.kind) {
    case 'ok':
    case 'locked':
    case 'no-phrase':
    case 'blocked':
      return undefined;
    case 'wrong-password':
      return s.regenWrong;
    case 'cancelled':
      return s.regenPasskeyCancelled;
    case 'rejected':
    case 'no-user-verification':
    case 'unavailable':
      return s.regenPasskeyFailed;
  }
}

export function RegeneratePhrase({
  controller,
  session,
}: {
  readonly controller: VaultController;
  readonly session: VaultSession;
}) {
  const { messages: m, language } = useLanguage();
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [password, setPassword] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  // Leaving the screen drops a phrase not yet committed.
  useEffect(
    () => () => {
      controller.cancelRegeneration();
    },
    [controller],
  );
  const date = (at: number) =>
    new Intl.DateTimeFormat(language, { dateStyle: 'long', timeStyle: 'short' }).format(at);
  const cancel = () => {
    controller.cancelRegeneration();
    setStep({ kind: 'idle' });
  };
  const block = session.regenerationBlock;
  if (block?.reason === 'no-envelope') return null;
  const run = (auth: ExportAuth) => {
    setWorking(true);
    setError(undefined);
    // Called in the click itself: a passkey assertion needs the user activation.
    void controller.regenerateRecoveryPhrase(auth).then((outcome) => {
      setPassword('');
      setWorking(false);
      if (outcome.kind === 'ok') setStep({ kind: 'done', recovery: outcome.recovery });
      else if (outcome.kind === 'blocked' || outcome.kind === 'no-phrase')
        setStep({ kind: 'idle' });
      else setError(regenerationError(m, outcome));
    });
  };
  return (
    <div className="flex flex-col gap-4" data-testid="regenerate">
      <h3 className="font-semibold">{m.settings.regenTitle}</h3>
      {step.kind === 'idle' || step.kind === 'done' ? (
        <>
          {step.kind === 'done' ? (
            <div className="flex flex-col gap-2" data-testid="regenerate-done">
              <p role="status" className="text-sm">
                {format(m.settings.regenDone, {
                  id: phraseLabel(step.recovery.phraseId),
                  date: date(step.recovery.phraseCreatedAt),
                })}
              </p>
              <Notice>{m.settings.regenOtherDevices}</Notice>
              <p className="text-sm">{m.settings.regenOldBackups}</p>
              <Button className="self-start" onClick={focusBackup}>
                {m.settings.regenBackupNow}
              </Button>
            </div>
          ) : null}
          {block?.reason === 'newer-content' ? <Notice>{m.settings.regenNewer}</Notice> : null}
          {block?.reason === 'future-clock' || block?.reason === 'read-only' ? (
            <Notice>
              {format(
                block.reason === 'future-clock'
                  ? m.settings.regenFutureClock
                  : m.settings.regenReadOnly,
                { date: date(block.until) },
              )}
            </Notice>
          ) : null}
          {step.kind === 'idle' && !block ? (
            <>
              <p className="text-sm">{m.settings.regenIntro}</p>
              <Button
                variant="quiet"
                className="self-start"
                data-testid="regenerate-start"
                onClick={() => {
                  setStep({ kind: 'warn' });
                }}
              >
                {m.settings.regenStart}
              </Button>
            </>
          ) : null}
        </>
      ) : null}
      {step.kind === 'warn' ? (
        <>
          <Notice>
            <span data-testid="regenerate-exposed">{m.settings.regenExposed}</span>
          </Notice>
          <p className="text-sm">{m.settings.regenBackups}</p>
          <Button
            className="self-start"
            onClick={() => {
              const words = controller.newRegenerationPhrase();
              setStep(
                words
                  ? { kind: 'phrase', words: words.split(' '), wrong: false }
                  : { kind: 'idle' },
              );
            }}
          >
            {m.settings.regenContinue}
          </Button>
        </>
      ) : null}
      {step.kind === 'phrase' ? (
        <PhraseWords
          title={m.settings.regenPhraseTitle}
          words={step.words}
          wrong={step.wrong}
          onWritten={() => {
            setStep({ kind: 'confirm', words: step.words, positions: drawPositions() });
          }}
        />
      ) : null}
      {step.kind === 'confirm' ? (
        <ConfirmWords
          words={step.words}
          positions={step.positions}
          onConfirmed={() => {
            // The words are no longer needed: only the controller's entropy remains.
            setStep({ kind: 'auth' });
          }}
          onWrong={() => {
            setStep({ kind: 'phrase', words: step.words, wrong: true });
          }}
        />
      ) : null}
      {step.kind === 'auth' ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            run({ kind: 'password', password });
          }}
        >
          <p className="text-sm">{m.settings.regenAuthIntro}</p>
          <Field
            label={m.settings.regenAuth}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError(undefined);
            }}
            error={error}
            data-testid="regenerate-password"
          />
          <Button type="submit" disabled={working || password === ''}>
            {working ? m.settings.regenWorking : m.settings.regenSubmit}
          </Button>
          {controller.hasPasskey ? (
            <Button
              variant="quiet"
              className="self-start"
              disabled={working}
              onClick={() => {
                run({ kind: 'passkey' });
              }}
            >
              {m.settings.regenPasskey}
            </Button>
          ) : null}
        </form>
      ) : null}
      {step.kind === 'warn' ||
      step.kind === 'phrase' ||
      step.kind === 'confirm' ||
      (step.kind === 'auth' && !working) ? (
        <Button variant="quiet" className="self-start" onClick={cancel}>
          {m.settings.regenCancel}
        </Button>
      ) : null}
    </div>
  );
}
