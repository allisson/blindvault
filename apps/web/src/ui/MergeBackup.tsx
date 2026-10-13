import { type MergeResult, type VaultSession } from '@blindvault/vault';
import { useState } from 'react';

import { type BackupHeaderInfo, type MergeOutcome, type VaultController } from '../app/controller';
import { useLanguage } from '../i18n/context';
import { type Messages, format } from '../i18n/messages';
import { Button, Notice } from './components';
import { ChooseFile, OpenBackup, fileError } from './RestoreVault';
import { recordTypeName } from './Settings';

// Backup merge (overview §10, sync-protocol.md §1, D182): file → secret → confirmation → result.
// The file is validated in full before the confirmation, and a merge writes nothing until then.

type Step =
  | { readonly kind: 'idle' }
  | { readonly kind: 'file' }
  | { readonly kind: 'secret'; readonly header: BackupHeaderInfo }
  | { readonly kind: 'confirm'; readonly exportedAt: number }
  | { readonly kind: 'done'; readonly result: MergeResult };

export function MergeBackup({
  controller,
  session,
}: {
  readonly controller: VaultController;
  readonly session: VaultSession;
}) {
  const { messages: m, language } = useLanguage();
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [error, setError] = useState<string | undefined>();
  const [merging, setMerging] = useState(false);
  const back = (message: string | undefined) => {
    setError(message);
    setStep({ kind: 'file' });
  };
  const cancel = () => {
    controller.cancelRestore();
    setError(undefined);
    setStep({ kind: 'idle' });
  };
  const date = (at: number, time: boolean) =>
    new Intl.DateTimeFormat(language, {
      dateStyle: 'long',
      ...(time ? { timeStyle: 'short' as const } : {}),
    }).format(at);
  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-semibold">{m.merge.title}</h2>
      <p className="text-sm">{m.merge.intro}</p>
      {step.kind === 'idle' || step.kind === 'done' ? (
        <Button
          variant="quiet"
          className="self-start"
          data-testid="merge-start"
          onClick={() => {
            setError(undefined);
            setStep({ kind: 'file' });
          }}
        >
          {m.merge.choose}
        </Button>
      ) : null}
      {step.kind === 'file' ? (
        <ChooseFile
          controller={controller}
          error={error}
          onFile={(check) => {
            if (check.kind === 'ok') {
              setError(undefined);
              setStep({ kind: 'secret', header: check.header });
            } else {
              setError(fileError(m, check));
            }
          }}
        />
      ) : null}
      {step.kind === 'secret' ? (
        <OpenBackup
          controller={controller}
          header={step.header}
          onOpened={(exportedAt) => {
            setError(undefined);
            setStep({ kind: 'confirm', exportedAt });
          }}
          onDropped={back}
        />
      ) : null}
      {step.kind === 'confirm' ? (
        <div className="flex flex-col gap-4" data-testid="merge-confirm">
          <p className="text-sm">
            {format(m.merge.confirm, { date: date(step.exportedAt, true) })}
          </p>
          <Button
            disabled={merging}
            onClick={() => {
              setMerging(true);
              void controller.mergeBackup().then((outcome) => {
                setMerging(false);
                if (outcome.kind === 'ok') {
                  setStep({ kind: 'done', result: outcome.result });
                } else {
                  back(mergeError(m, outcome, (at) => date(at, true)));
                }
              });
            }}
          >
            {merging ? m.merge.merging : m.merge.submit}
          </Button>
        </div>
      ) : null}
      {step.kind === 'done' ? (
        <MergeNotices
          result={step.result}
          phraseCreatedAt={session.recovery?.phraseCreatedAt}
          date={(at) => date(at, false)}
        />
      ) : null}
      {step.kind === 'file' || step.kind === 'secret' || (step.kind === 'confirm' && !merging) ? (
        <Button variant="quiet" className="self-start" onClick={cancel}>
          {m.restore.cancel}
        </Button>
      ) : null}
    </section>
  );
}

/** The merge's result and the notices it calls for, shown once (sync-protocol.md §1.6). */
function MergeNotices({
  result,
  phraseCreatedAt,
  date,
}: {
  readonly result: MergeResult;
  readonly phraseCreatedAt: number | undefined;
  readonly date: (at: number) => string;
}) {
  const m = useLanguage().messages;
  const names = (devices: MergeResult['newDevices'], marked: boolean) =>
    devices
      .map((d) =>
        marked && d.device.retired
          ? format(m.merge.alreadyRetired, { name: d.device.displayName })
          : d.device.displayName,
      )
      .join(', ');
  return (
    <div className="flex flex-col gap-2" data-testid="merge-result">
      <p role="status" className="text-sm">
        {format(m.merge.done, {
          added: String(result.added),
          replaced: String(result.replaced),
        })}
      </p>
      {result.phraseChanged && phraseCreatedAt !== undefined ? (
        <Notice>{format(m.merge.phraseChanged, { date: date(phraseCreatedAt) })}</Notice>
      ) : null}
      {result.newDevices.length > 0 ? (
        <Notice>{format(m.merge.newDevices, { names: names(result.newDevices, true) })}</Notice>
      ) : null}
      {result.retiredDevices.length > 0 ? (
        <Notice>
          {format(m.merge.retiredDevices, { names: names(result.retiredDevices, false) })}
        </Notice>
      ) : null}
      {result.droppedLosers.length > 0 ? (
        <Notice>
          {format(m.merge.droppedLosers, {
            titles: result.droppedLosers.map((d) => d.title).join(', '),
          })}
        </Notice>
      ) : null}
    </div>
  );
}

function mergeError(
  m: Messages,
  outcome: Exclude<MergeOutcome, { readonly kind: 'ok' }>,
  date: (at: number) => string,
): string {
  switch (outcome.kind) {
    case 'no-backup':
    case 'locked':
      return m.merge.locked;
    case 'different-vault':
      return m.merge.differentVault;
    case 'master-key-mismatch':
      return m.merge.masterKey;
    case 'future-clock':
      return format(m.merge.futureClock, { date: date(outcome.retryAt) });
    case 'corrupt-record':
    case 'immutable-record':
      return format(outcome.kind === 'corrupt-record' ? m.merge.corruptRecord : m.merge.immutable, {
        type: recordTypeName(m, outcome.recordType),
        id: outcome.recordId,
      });
  }
}
