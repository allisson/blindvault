import { type Item, type VaultSession } from '@blindvault/vault';
import { useState } from 'react';

import { hex } from '../app/ids';
import { type Navigation } from '../app/nav';
import { useLanguage } from '../i18n/context';
import { format } from '../i18n/messages';
import { Button, Notice } from './components';
import { writeError } from './errors';
import { FieldValue, fieldName } from './ItemDetail';

function VersionFields({
  item,
  clearSeconds,
}: {
  readonly item: Item;
  readonly clearSeconds: number;
}) {
  const m = useLanguage().messages;
  return (
    <dl className="flex flex-col gap-3">
      {item.fields.map((field, i) => {
        const name = fieldName(m, item, field);
        return (
          // Fields have no ID; a version never changes.
          <div key={i} className="flex flex-col gap-0.5">
            <dt className="text-xs font-medium text-zinc-500">{name}</dt>
            <dd>
              <FieldValue field={field} name={name} clearSeconds={clearSeconds} />
            </dd>
          </div>
        );
      })}
      {item.notes !== undefined ? (
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs font-medium text-zinc-500">{m.items.notes}</dt>
          <dd className="break-words whitespace-pre-wrap">{item.notes}</dd>
        </div>
      ) : null}
    </dl>
  );
}

/**
 * An item's Item Versions, newest first, each restorable as a new edit (D6, D111). It says that
 * old values stay until the original is trashed and purged, and how to remove them (D135).
 */
export function ItemHistory({
  session,
  id,
  nav,
  onChange,
}: {
  readonly session: VaultSession;
  readonly id: Uint8Array;
  readonly nav: Navigation;
  readonly onChange: () => void;
}) {
  const { messages: m, language } = useLanguage();
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);
  const view = session.item(id);
  if (!view) return null;
  const restorable = view.item !== undefined && view.readOnly === undefined && !view.inTrash;
  const when = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' });
  const versions = session.versions(id);

  return (
    <article className="flex w-full max-w-2xl flex-col gap-4 p-4">
      <h1 className="text-xl font-semibold break-words">
        {format(m.items.historyTitle, { title: view.item?.title ?? m.items.newerTitle })}
      </h1>
      <Notice>{m.items.historyNote}</Notice>
      {versions.length === 0 ? <p className="text-sm text-zinc-500">{m.items.noHistory}</p> : null}
      <ol className="flex flex-col gap-4">
        {versions.map((v) => (
          <li
            key={hex(v.versionId)}
            className="flex flex-col gap-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-800"
          >
            <header className="flex flex-col gap-0.5">
              <h2 className="font-semibold break-words">{v.item?.title ?? m.items.newerTitle}</h2>
              <p className="text-sm text-zinc-500">{when.format(v.hlc.physicalMs)}</p>
            </header>
            {v.readOnly === 'newer-content' ? <Notice>{m.items.versionNewer}</Notice> : null}
            {v.readOnly === 'future-clock' ? <Notice>{m.items.versionClock}</Notice> : null}
            {v.item ? (
              <VersionFields
                item={v.item}
                clearSeconds={session.preferences.clipboardClearSeconds}
              />
            ) : null}
            {restorable && v.item && v.readOnly === undefined && session.writable ? (
              <Button
                variant="quiet"
                className="self-start"
                disabled={working}
                onClick={() => {
                  setWorking(true);
                  setError(undefined);
                  session.restoreVersion(id, v.versionId).then(
                    () => {
                      onChange();
                      nav.back();
                    },
                    (e: unknown) => {
                      setWorking(false);
                      setError(writeError(e, m));
                    },
                  );
                }}
              >
                {m.items.restoreVersion}
              </Button>
            ) : null}
          </li>
        ))}
      </ol>
      <Button
        variant="quiet"
        className="self-start"
        onClick={() => {
          nav.back();
        }}
      >
        {m.items.backToItem}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </article>
  );
}
