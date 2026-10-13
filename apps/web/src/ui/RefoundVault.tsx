import { type VaultSession } from '@blindvault/vault';
import { useCallback, useEffect, useState } from 'react';

import { recordIdPrefix } from '../app/backup-file';
import { type ExportAuth, type RefoundingStart, type VaultController } from '../app/controller';
import { deviceName } from '../app/device-name';
import { type Navigation } from '../app/nav';
import { drawPositions } from '../app/phrase-check';
import { useLanguage } from '../i18n/context';
import { type Messages, format } from '../i18n/messages';
import { Button, Field, Notice } from './components';
import { NewPassword } from './NewPassword';
import { ConfirmWords, PhraseWords } from './PhraseSteps';

// Re-founding (§14, D28, D46, D47, D72, D116, D187): warnings and their confirmation → local
// password or passkey → new phrase → confirmation → new local password → commit. Nothing is written
// before the last step; the inactivity lock pauses while the controller holds the phrase (D104),
// and leaving this screen or a lock drops it (D93).

type Step =
  | { readonly kind: 'idle' }
  | { readonly kind: 'warn' }
  | { readonly kind: 'auth' }
  | { readonly kind: 'phrase'; readonly words: readonly string[]; readonly wrong: boolean }
  | {
      readonly kind: 'confirm';
      readonly words: readonly string[];
      readonly positions: readonly number[];
    }
  | { readonly kind: 'password' };

function authError(m: Messages, outcome: RefoundingStart): string | undefined {
  switch (outcome) {
    case 'ok':
    case 'locked':
      return undefined;
    case 'wrong-password':
      return m.refound.wrong;
    case 'cancelled':
      return m.refound.passkeyCancelled;
    case 'rejected':
    case 'no-user-verification':
    case 'unavailable':
      return m.refound.passkeyFailed;
  }
}

/** The names of the peers whose records were rejected (D116): their device names, or IDs. */
function rejectedNames(session: VaultSession): string {
  const devices = session.devices();
  return session.rejectedPeers
    .map((id) => {
      const held = devices.find((d) => d.deviceId.every((b, i) => b === id[i]));
      return held?.device.displayName ?? recordIdPrefix(id);
    })
    .join(', ');
}

export function RefoundVault({
  controller,
  session,
  nav,
}: {
  readonly controller: VaultController;
  readonly session: VaultSession;
  readonly nav: Navigation;
}) {
  const m = useLanguage().messages;
  const r = m.refound;
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [understood, setUnderstood] = useState(false);
  const [understoodRejected, setUnderstoodRejected] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const onNext = useCallback((p: string | null) => {
    setNext(p);
  }, []);
  // Leaving the screen drops a re-founding not yet committed.
  useEffect(
    () => () => {
      controller.cancelRefounding();
    },
    [controller],
  );
  const cancel = () => {
    controller.cancelRefounding();
    setStep({ kind: 'idle' });
    setUnderstood(false);
    setUnderstoodRejected(false);
    setError(undefined);
  };
  const rejected = session.rejectedPeers.length > 0 ? rejectedNames(session) : undefined;
  const corrupt = session.corrupt().length;
  const auth = (how: ExportAuth) => {
    setWorking(true);
    setError(undefined);
    // Called in the click itself: a passkey assertion needs the user activation.
    void controller.beginRefounding(how).then((outcome) => {
      setCurrent('');
      setWorking(false);
      if (outcome === 'ok') {
        const words = controller.newRefoundingPhrase();
        setStep(
          words ? { kind: 'phrase', words: words.split(' '), wrong: false } : { kind: 'idle' },
        );
      } else if (outcome === 'locked') {
        setStep({ kind: 'idle' });
      } else {
        setError(authError(m, outcome));
      }
    });
  };
  return (
    <section className="flex flex-col gap-4" data-testid="refound">
      <h2 className="font-semibold">{r.title}</h2>
      {step.kind === 'idle' ? (
        <>
          <p className="text-sm">{r.intro}</p>
          <Button
            variant="quiet"
            className="self-start"
            data-testid="refound-start"
            onClick={() => {
              setStep({ kind: 'warn' });
            }}
          >
            {r.start}
          </Button>
        </>
      ) : null}
      {step.kind === 'warn' ? (
        <div className="flex flex-col gap-3" data-testid="refound-warnings">
          <Notice>{session.retired ? r.warnRetired : r.warnSync}</Notice>
          <Notice>{r.warnTrash}</Notice>
          <Button
            variant="quiet"
            className="self-start"
            onClick={() => {
              cancel();
              nav.showList({ name: 'trash' });
            }}
          >
            {r.openTrash}
          </Button>
          {corrupt > 0 ? (
            <Notice>
              <span data-testid="refound-corrupt">
                {format(r.warnCorrupt, { n: String(corrupt) })}
              </span>
            </Notice>
          ) : null}
          {rejected ? (
            <Notice>
              <span data-testid="refound-rejected">
                {format(r.warnRejected, { names: rejected })}
              </span>
            </Notice>
          ) : null}
          <p className="text-sm">{r.warnCopied}</p>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={understood}
              onChange={(e) => {
                setUnderstood(e.target.checked);
              }}
              data-testid="refound-understand"
            />
            {r.understand}
          </label>
          {rejected ? (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={understoodRejected}
                onChange={(e) => {
                  setUnderstoodRejected(e.target.checked);
                }}
                data-testid="refound-understand-rejected"
              />
              {format(r.understandRejected, { names: rejected })}
            </label>
          ) : null}
          <Button
            className="self-start"
            disabled={!understood || (rejected !== undefined && !understoodRejected)}
            onClick={() => {
              setStep({ kind: 'auth' });
            }}
          >
            {r.continue}
          </Button>
        </div>
      ) : null}
      {step.kind === 'auth' ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            auth({ kind: 'password', password: current });
          }}
        >
          <p className="text-sm">{r.authIntro}</p>
          <Field
            label={r.auth}
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => {
              setCurrent(e.target.value);
              setError(undefined);
            }}
            error={error}
            data-testid="refound-password"
          />
          <Button type="submit" disabled={working || current === ''}>
            {r.authSubmit}
          </Button>
          {controller.hasPasskey ? (
            <Button
              variant="quiet"
              className="self-start"
              disabled={working}
              onClick={() => {
                auth({ kind: 'passkey' });
              }}
            >
              {r.authPasskey}
            </Button>
          ) : null}
        </form>
      ) : null}
      {step.kind === 'phrase' ? (
        <PhraseWords
          title={r.phraseTitle}
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
            setStep({ kind: 'password' });
          }}
          onWrong={() => {
            setStep({ kind: 'phrase', words: step.words, wrong: true });
          }}
        />
      ) : null}
      {step.kind === 'password' ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!next) return;
            setWorking(true);
            setError(undefined);
            void controller.refound(next, deviceName(navigator.userAgent)).then((outcome) => {
              setWorking(false);
              // `ok`: the new vault's session replaces this screen.
              if (outcome.kind === 'busy') setError(r.busy);
              else if (outcome.kind !== 'ok') setStep({ kind: 'idle' });
            });
          }}
        >
          <p className="text-sm">{r.passwordIntro}</p>
          <NewPassword label={r.password} confirmLabel={r.confirmPassword} onChange={onNext} />
          <Button type="submit" disabled={working || !next}>
            {working ? r.working : r.submit}
          </Button>
          {error ? (
            <p role="alert" className="text-sm text-red-700 dark:text-red-400">
              {error}
            </p>
          ) : null}
        </form>
      ) : null}
      {step.kind !== 'idle' && !working ? (
        <Button variant="quiet" className="self-start" onClick={cancel}>
          {r.cancel}
        </Button>
      ) : null}
    </section>
  );
}
