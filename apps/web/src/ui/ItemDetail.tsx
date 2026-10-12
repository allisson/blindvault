import {
  type Field,
  type Item,
  type VaultSession,
  seedPhraseChecksumValid,
} from '@blindvault/vault';
import { useState } from 'react';

import { type Navigation } from '../app/nav';
import { useLanguage } from '../i18n/context';
import { type Messages, format, roleName } from '../i18n/messages';
import { Button, Notice } from './components';
import { writeError } from './errors';
import { SecretView } from './Secret';

/** A field's name: the user's label, else its role's localized name (D165). */
export function fieldName(m: Messages, item: Pick<Item, 'templateId'>, field: Field): string {
  return (
    field.label ??
    (field.role !== undefined ? roleName(m, item.templateId, field.role) : undefined) ??
    field.role ??
    ''
  );
}

/** Only `http` and `https` are opened (record-content.md §4, D83). */
function openable(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function FieldValue({ field, name }: { readonly field: Field; readonly name: string }) {
  const m = useLanguage().messages;
  const { value } = field;
  if (typeof value !== 'string') return <SecretView value={value.secret} label={name} />;
  switch (field.type) {
    case 'secret':
      return <SecretView value={value} label={name} />;
    case 'seed-phrase':
      return (
        <div className="flex flex-col gap-1">
          <SecretView value={value} label={name} />
          {seedPhraseChecksumValid(value) ? null : (
            <p className="text-sm text-amber-800 dark:text-amber-200">{m.items.checksum}</p>
          )}
        </div>
      );
    case 'url':
      return (
        <span className="flex items-center gap-2 break-all">
          {value}
          {openable(value) ? (
            <a
              href={value}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
              className="text-sm font-medium underline"
            >
              {m.items.open}
            </a>
          ) : null}
        </span>
      );
    default:
      return <span className="break-words whitespace-pre-wrap">{value}</span>;
  }
}

export function ItemDetail({
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
  const { item } = view;
  const editable = item !== undefined && view.readOnly === undefined && session.writable;

  const act = (write: () => Promise<unknown>) => {
    setWorking(true);
    setError(undefined);
    write().then(
      () => {
        onChange();
        nav.close(id);
      },
      (e: unknown) => {
        setWorking(false);
        setError(writeError(e, m));
      },
    );
  };

  return (
    <article className="flex w-full max-w-2xl flex-col gap-4 p-4" aria-label={item?.title}>
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold break-words">{item?.title ?? m.items.newerTitle}</h1>
        {item ? (
          <p className="text-sm text-zinc-500">
            {m.templates[item.templateId as keyof Messages['templates']]}
          </p>
        ) : null}
      </header>
      {view.readOnly === 'newer-content' ? <Notice>{m.items.readOnlyNewer}</Notice> : null}
      {view.readOnly === 'future-clock' ? <Notice>{m.items.readOnlyClock}</Notice> : null}
      {view.inTrash && view.purgeAt !== undefined ? (
        <Notice>
          {format(m.items.inTrash, {
            date: new Intl.DateTimeFormat(language, { dateStyle: 'long' }).format(view.purgeAt),
          })}
        </Notice>
      ) : null}
      {item ? (
        <dl className="flex flex-col gap-3">
          {item.fields.map((field, i) => {
            const name = fieldName(m, item, field);
            return (
              // Fields have no ID; their order is fixed while the item is shown.
              <div key={i} className="flex flex-col gap-0.5">
                <dt className="text-xs font-medium text-zinc-500">{name}</dt>
                <dd>
                  <FieldValue field={field} name={name} />
                </dd>
              </div>
            );
          })}
          {item.folderId && session.folder(item.folderId)?.inTrash === false ? (
            <div className="flex flex-col gap-0.5">
              <dt className="text-xs font-medium text-zinc-500">{m.folders.folder}</dt>
              <dd>{session.folder(item.folderId)?.name}</dd>
            </div>
          ) : null}
          {item.tags.length > 0 ? (
            <div className="flex flex-col gap-0.5">
              <dt className="text-xs font-medium text-zinc-500">{m.items.tags}</dt>
              <dd className="flex flex-wrap gap-1">
                {item.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full bg-zinc-100 px-2 py-0.5 text-sm dark:bg-zinc-800"
                  >
                    {tag}
                  </span>
                ))}
              </dd>
            </div>
          ) : null}
          {item.notes !== undefined ? (
            <div className="flex flex-col gap-0.5">
              <dt className="text-xs font-medium text-zinc-500">{m.items.notes}</dt>
              <dd className="break-words whitespace-pre-wrap">{item.notes}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      {editable ? (
        <div className="flex flex-wrap gap-2">
          {view.inTrash ? (
            // An item in the trash allows only restore from the trash (D143).
            <Button
              disabled={working}
              onClick={() => {
                act(() => session.restoreItem(id));
              }}
            >
              {m.items.restore}
            </Button>
          ) : (
            <>
              <Button
                disabled={working}
                onClick={() => {
                  nav.open({ name: 'edit', id });
                }}
              >
                {m.items.edit}
              </Button>
              <Button
                variant="quiet"
                disabled={working}
                onClick={() => {
                  act(() => session.trashItem(id));
                }}
              >
                {m.items.moveToTrash}
              </Button>
            </>
          )}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </article>
  );
}
