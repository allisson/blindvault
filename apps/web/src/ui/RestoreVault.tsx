import { useCallback, useState } from 'react';

import { phraseLabel } from '../app/backup-file';
import {
  type BackupFileCheck,
  type BackupHeaderInfo,
  type BackupOpening,
  type RestoreOutcome,
  type VaultController,
} from '../app/controller';
import { useLanguage } from '../i18n/context';
import { type Messages, format } from '../i18n/messages';
import { Button, Card, Field, Notice, TARGET, TextArea } from './components';
import { NewPassword } from './NewPassword';
import { recordTypeName } from './Settings';

// Restore from a backup (overview §10, backup-format.md §8): file → secret → local password. The
// file is validated in full before the password step, and nothing is written before the commit
// (D33, D104). The header is shown unverified until a keyslot opens it (D95). With `replace`, the
// same steps replace the locked vault, after the warning and an explicit confirmation (D183).

type Step =
  | { readonly kind: 'file' }
  | { readonly kind: 'secret'; readonly header: BackupHeaderInfo }
  | { readonly kind: 'password'; readonly exportedAt: number };

export function RestoreVault({
  controller,
  working,
  replace = false,
  onCancel,
}: {
  readonly controller: VaultController;
  readonly working: boolean;
  readonly replace?: boolean;
  readonly onCancel: () => void;
}) {
  const { messages: m } = useLanguage();
  const [step, setStep] = useState<Step>({ kind: 'file' });
  const [error, setError] = useState<string | undefined>();
  const back = (message: string | undefined) => {
    setError(message);
    setStep({ kind: 'file' });
  };
  const cancel = () => {
    controller.cancelRestore();
    onCancel();
  };
  return (
    <Card title={replace ? m.replace.title : m.restore.title}>
      {replace ? (
        <div className="flex flex-col gap-2" data-testid="replace-warning">
          <Notice>{m.replace.warning}</Notice>
          <p className="text-sm">{m.replace.retire}</p>
        </div>
      ) : null}
      {step.kind === 'file' ? (
        <ChooseFile
          error={error}
          onFile={(check) => {
            if (check.kind === 'ok') {
              setError(undefined);
              setStep({ kind: 'secret', header: check.header });
            } else {
              setError(fileError(m, check));
            }
          }}
          controller={controller}
        />
      ) : null}
      {step.kind === 'secret' ? (
        <OpenBackup
          controller={controller}
          header={step.header}
          onOpened={(exportedAt) => {
            setError(undefined);
            setStep({ kind: 'password', exportedAt });
          }}
          onDropped={back}
        />
      ) : null}
      {step.kind === 'password' ? (
        <RestorePassword
          controller={controller}
          working={working}
          replace={replace}
          exportedAt={step.exportedAt}
          onFailed={back}
        />
      ) : null}
      {working ? null : (
        <Button variant="quiet" className="self-start" onClick={cancel}>
          {m.restore.cancel}
        </Button>
      )}
    </Card>
  );
}

export function ChooseFile({
  controller,
  error,
  onFile,
}: {
  readonly controller: VaultController;
  readonly error: string | undefined;
  readonly onFile: (check: BackupFileCheck) => void;
}) {
  const { messages: m } = useLanguage();
  const [reading, setReading] = useState(false);
  return (
    <>
      <p className="text-sm">{m.restore.intro}</p>
      <Field
        label={m.restore.file}
        type="file"
        accept=".bvault"
        disabled={reading}
        error={error}
        className="py-2 text-sm"
        data-testid="restore-file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          setReading(true);
          void file.arrayBuffer().then((buffer) => {
            setReading(false);
            onFile(controller.openBackupFile(new Uint8Array(buffer)));
          });
        }}
      />
    </>
  );
}

export function OpenBackup({
  controller,
  header,
  onOpened,
  onDropped,
}: {
  readonly controller: VaultController;
  readonly header: BackupHeaderInfo;
  readonly onOpened: (exportedAt: number) => void;
  readonly onDropped: (message: string | undefined) => void;
}) {
  const { messages: m, language } = useLanguage();
  const [method, setMethod] = useState<'phrase' | 'password'>('phrase');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [opening, setOpening] = useState(false);
  const date = new Intl.DateTimeFormat(language, { dateStyle: 'long' }).format(
    header.phraseCreatedAt,
  );
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        setOpening(true);
        setError(undefined);
        const typed =
          method === 'phrase'
            ? ({ kind: 'phrase', words: secret } as const)
            : ({ kind: 'password', password: secret } as const);
        // The secret leaves the field at once, whatever the result.
        setSecret('');
        void controller.openBackup(typed).then((opening) => {
          setOpening(false);
          if (opening.kind === 'ok') {
            onOpened(opening.exportedAt);
            return;
          }
          const message = openingError(m, opening, method);
          if (kept(opening)) setError(message);
          else onDropped(message);
        });
      }}
    >
      <p className="text-sm" data-testid="restore-header">
        {format(m.restore.header, { date, id: phraseLabel(header.phraseId) })}
      </p>
      {header.hasExportPassword ? (
        <fieldset className="flex gap-4 text-sm">
          <legend className="sr-only">{m.restore.method}</legend>
          {(['phrase', 'password'] as const).map((value) => (
            <label key={value} className={`${TARGET} flex items-center gap-2`}>
              <input
                type="radio"
                name="restore-method"
                checked={method === value}
                onChange={() => {
                  setMethod(value);
                  setSecret('');
                  setError(undefined);
                }}
              />
              {value === 'phrase' ? m.restore.byPhrase : m.restore.byPassword}
            </label>
          ))}
        </fieldset>
      ) : null}
      {method === 'phrase' ? (
        <TextArea
          label={m.restore.phrase}
          autoCapitalize="none"
          autoFocus
          value={secret}
          error={error}
          onChange={(e) => {
            setSecret(e.target.value);
          }}
          data-testid="restore-phrase"
        />
      ) : (
        <Field
          label={m.restore.password}
          type="password"
          autoComplete="off"
          autoFocus
          value={secret}
          error={error}
          onChange={(e) => {
            setSecret(e.target.value);
          }}
          data-testid="restore-export-password"
        />
      )}
      <Button type="submit" disabled={secret.trim() === '' || opening}>
        {opening ? m.restore.opening : m.restore.open}
      </Button>
    </form>
  );
}

function RestorePassword({
  controller,
  working,
  replace,
  exportedAt,
  onFailed,
}: {
  readonly controller: VaultController;
  readonly working: boolean;
  readonly replace: boolean;
  readonly exportedAt: number;
  readonly onFailed: (message: string | undefined) => void;
}) {
  const { messages: m, language } = useLanguage();
  const [password, setPassword] = useState<string | null>(null);
  const [understood, setUnderstood] = useState(false);
  const onChange = useCallback((p: string | null) => {
    setPassword(p);
  }, []);
  const date = new Intl.DateTimeFormat(language, { dateStyle: 'long', timeStyle: 'short' }).format(
    exportedAt,
  );
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!password || (replace && !understood)) return;
        void controller.restore(password, { replace }).then((outcome) => {
          if (outcome.kind !== 'ok') onFailed(restoreError(m, outcome));
        });
      }}
    >
      <p className="text-sm" data-testid="restore-opened">
        {format(m.restore.opened, { date })}
      </p>
      <p className="text-sm">{m.restore.passwordIntro}</p>
      <NewPassword label={m.restore.local} confirmLabel={m.restore.confirm} onChange={onChange} />
      {replace ? (
        <label className={`${TARGET} flex items-center gap-2 text-sm`}>
          <input
            type="checkbox"
            checked={understood}
            onChange={(e) => {
              setUnderstood(e.target.checked);
            }}
            data-testid="replace-understood"
          />
          {m.replace.understand}
        </label>
      ) : null}
      <Button type="submit" disabled={!password || (replace && !understood) || working}>
        {replace
          ? working
            ? m.replace.replacing
            : m.replace.submit
          : working
            ? m.restore.restoring
            : m.restore.submit}
      </Button>
    </form>
  );
}

export function fileError(m: Messages, check: BackupFileCheck): string | undefined {
  switch (check.kind) {
    case 'ok':
    case 'unavailable':
      return undefined;
    case 'not-a-backup':
      return m.restore.notBackup;
    case 'newer-version':
      return m.restore.newerVersion;
    case 'malformed':
      return m.restore.malformed;
  }
}

/** Whether the file stays open for another try after this outcome. */
export function kept(opening: BackupOpening): boolean {
  return (
    opening.kind === 'wrong-secret' ||
    opening.kind === 'invalid-phrase' ||
    opening.kind === 'no-password-keyslot'
  );
}

export function openingError(
  m: Messages,
  opening: BackupOpening,
  method: 'phrase' | 'password',
): string | undefined {
  const r = m.restore;
  switch (opening.kind) {
    case 'ok':
    case 'no-file':
      return undefined;
    case 'wrong-secret':
      return method === 'phrase' ? r.wrongPhrase : r.wrongPassword;
    case 'no-password-keyslot':
      return r.noPasswordKeyslot;
    case 'invalid-phrase':
      if (opening.reason === 'word-count') return m.settings.recoveryWordCount;
      if (opening.reason === 'checksum') return m.settings.recoveryChecksum;
      return format(m.settings.recoveryUnknownWord, { n: String(opening.position ?? '') });
    case 'not-a-backup':
      return r.notBackup;
    case 'newer-version':
    case 'newer-record':
      return r.newerVersion;
    case 'malformed':
    case 'corrupt':
      return r.corrupt;
    case 'envelope-mismatch':
    case 'master-key-mismatch':
    case 'public-key-mismatch':
      return r.inconsistent;
    case 'locked':
      return r.locked;
    case 'different-vault':
      return m.merge.differentVault;
    case 'corrupt-record':
      return opening.recordType !== undefined && opening.recordId !== undefined
        ? format(r.corruptRecord, {
            type: recordTypeName(m, opening.recordType),
            id: opening.recordId,
          })
        : r.corruptUnnamed;
  }
}

function restoreError(m: Messages, outcome: RestoreOutcome): string | undefined {
  switch (outcome.kind) {
    case 'ok':
      return undefined;
    case 'locked':
    case 'no-backup':
      return m.restore.locked;
    case 'busy':
      return m.start.busy;
    case 'corrupt-record':
      return format(m.restore.corruptRecord, {
        type: recordTypeName(m, outcome.recordType),
        id: outcome.recordId,
      });
  }
}
