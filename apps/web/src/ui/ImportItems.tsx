import {
  HlcReadOnlyError,
  type MappedImport,
  VaultLockedError,
  type VaultSession,
} from '@blindvault/vault';
import { useState } from 'react';

import { type VaultController } from '../app/controller';
import { IMPORT_SOURCES, type ImportRead, type ImportSource, MAX_IMPORT_SIZE } from '../app/import';
import { useLanguage } from '../i18n/context';
import { type Messages, format } from '../i18n/messages';
import { Button, Field, INPUT, Notice } from './components';
import { writeError } from './errors';

// Import (overview §15, D123, D125): source → file → passphrase for a `.blindpass` → preview →
// one commit into a new landing folder. Nothing is written before the confirmation, and a lock
// unmounts this screen, dropping what was read.

type Step =
  | { readonly kind: 'idle' }
  | { readonly kind: 'file' }
  | { readonly kind: 'passphrase'; readonly bytes: Uint8Array; readonly fileName: string }
  | {
      readonly kind: 'preview';
      readonly mapped: MappedImport;
      readonly fileName: string;
      readonly folder: string;
    }
  | {
      readonly kind: 'done';
      readonly count: number;
      readonly fileName: string;
      readonly folder: string;
    };

const SOURCES = Object.keys(IMPORT_SOURCES) as ImportSource[];
const FILE_INPUT =
  'py-2 text-sm file:mr-3 file:min-h-10 file:cursor-pointer file:rounded-control file:border file:border-control file:bg-raised file:px-4 file:text-sm file:font-medium file:text-fg enabled:hover:file:bg-subtle';

export function ImportItems({
  controller,
  session,
}: {
  readonly controller: VaultController;
  readonly session: VaultSession;
}) {
  const { messages: m, language } = useLanguage();
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [source, setSource] = useState<ImportSource>('bitwarden');
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const name = IMPORT_SOURCES[source].name;

  const cancel = () => {
    setError(undefined);
    setPassphrase('');
    setStep({ kind: 'idle' });
  };
  const read = async (bytes: Uint8Array, fileName: string, secret?: string) => {
    setBusy(true);
    const result = await controller.readImport(source, bytes, secret);
    setBusy(false);
    setPassphrase('');
    if (result.kind === 'ok') {
      const date = new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(Date.now());
      setError(undefined);
      setStep({
        kind: 'preview',
        mapped: result.mapped,
        fileName,
        folder: format(m.import.folder, { source: name, date }),
      });
    } else if (result.kind === 'passphrase' || result.kind === 'wrong-passphrase') {
      setError(result.kind === 'wrong-passphrase' ? m.import.wrongPassphrase : undefined);
      setStep({ kind: 'passphrase', bytes, fileName });
    } else if (result.kind === 'locked') {
      cancel();
    } else {
      setError(readError(m, result, name));
      setStep({ kind: 'file' });
    }
  };

  return (
    <section className="flex flex-col gap-4" data-section="import">
      <h2 tabIndex={-1} className="font-semibold">
        {m.import.title}
      </h2>
      <p className="text-sm">{m.import.intro}</p>
      {!session.writable ? (
        <Notice>{m.import.readOnly}</Notice>
      ) : step.kind === 'idle' || step.kind === 'done' ? (
        <Button
          variant="quiet"
          className="self-start"
          data-testid="import-start"
          onClick={() => {
            setError(undefined);
            setStep({ kind: 'file' });
          }}
        >
          {m.import.choose}
        </Button>
      ) : null}
      {step.kind === 'file' ? (
        <>
          <label className="flex flex-col gap-1 text-sm font-medium">
            {m.import.source}
            <select
              className={INPUT}
              value={source}
              disabled={busy}
              data-testid="import-source"
              onChange={(e) => {
                const next = SOURCES.find((s) => s === e.target.value);
                if (next) setSource(next);
                setError(undefined);
              }}
            >
              {SOURCES.map((s) => (
                <option key={s} value={s}>
                  {IMPORT_SOURCES[s].name}
                </option>
              ))}
            </select>
          </label>
          <Notice>{m.import.plaintext}</Notice>
          <Field
            label={m.import.file}
            type="file"
            accept={IMPORT_SOURCES[source].accept}
            disabled={busy}
            error={error}
            className={FILE_INPUT}
            data-testid="import-file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              // Refused before reading it into memory (D130).
              if (file.size > MAX_IMPORT_SIZE) {
                setError(m.import.tooLarge);
                return;
              }
              setBusy(true);
              void file.arrayBuffer().then((buffer) => read(new Uint8Array(buffer), file.name));
            }}
          />
        </>
      ) : null}
      {step.kind === 'passphrase' ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void read(step.bytes, step.fileName, passphrase);
          }}
        >
          <Field
            label={m.import.passphrase}
            hint={m.import.passphraseHint}
            type="password"
            value={passphrase}
            disabled={busy}
            error={error}
            data-testid="import-passphrase"
            onChange={(e) => {
              setPassphrase(e.target.value);
            }}
          />
          <Button type="submit" className="self-start" busy={busy} disabled={passphrase === ''}>
            {busy ? m.import.opening : m.import.open}
          </Button>
        </form>
      ) : null}
      {step.kind === 'preview' ? (
        <div className="flex flex-col gap-4" data-testid="import-preview">
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
            <li>
              {format(m.import.found, {
                count: String(step.mapped.items.length),
                folder: step.folder,
              })}
            </li>
            <li>{format(m.import.skipped, { count: String(step.mapped.skipped) })}</li>
            <li>{format(m.import.attachments, { count: String(step.mapped.attachments) })}</li>
            <li>{format(m.import.notes, { count: String(step.mapped.notes) })}</li>
          </ul>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          {step.mapped.items.length > 0 ? (
            <Button
              className="self-start"
              busy={busy}
              data-testid="import-confirm"
              onClick={() => {
                setBusy(true);
                session.importItems(step.folder, step.mapped.items).then(
                  () => {
                    setBusy(false);
                    setError(undefined);
                    const { fileName, folder } = step;
                    setStep({ kind: 'done', count: step.mapped.items.length, fileName, folder });
                  },
                  (e: unknown) => {
                    setBusy(false);
                    if (e instanceof VaultLockedError) return;
                    setError(e instanceof HlcReadOnlyError ? m.import.readOnly : writeError(e, m));
                  },
                );
              }}
            >
              {busy ? m.import.importing : m.import.submit}
            </Button>
          ) : (
            <p className="text-sm">{m.import.nothing}</p>
          )}
        </div>
      ) : null}
      {step.kind === 'done' ? (
        <div className="flex flex-col gap-2" data-testid="import-result">
          <p role="status" className="text-sm">
            {format(m.import.done, { count: String(step.count), folder: step.folder })}
          </p>
          <Notice>{format(m.import.deleteFile, { file: step.fileName })}</Notice>
        </div>
      ) : null}
      {(step.kind === 'file' || step.kind === 'passphrase' || step.kind === 'preview') && !busy ? (
        <Button variant="quiet" className="self-start" onClick={cancel}>
          {m.import.cancel}
        </Button>
      ) : null}
    </section>
  );
}

function readError(
  m: Messages,
  read: Extract<ImportRead, { readonly kind: 'rejected' | 'kdf-failed' }>,
  source: string,
): string {
  if (read.kind === 'kdf-failed') return m.import.kdfFailed;
  switch (read.reason) {
    case 'too-large':
      return m.import.tooLarge;
    case 'encrypted-export':
      return format(m.import.encrypted, { source });
    case 'missing-columns':
      return format(m.import.missingColumns, { source });
    case 'unsupported-version':
      return format(m.import.unsupportedVersion, { source });
    case 'invalid-item':
      return format(m.import.invalidItem, { number: String((read.item ?? 0) + 1) });
    case 'not-this-format':
      return format(m.import.notThisFormat, { source });
  }
}
