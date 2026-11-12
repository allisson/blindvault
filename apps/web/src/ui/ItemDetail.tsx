import {
  ContentInvalidError,
  type Field,
  type Item,
  type VaultSession,
  seedPhraseChecksumValid,
} from '@blindvault/vault';
import { type ReactNode, useId, useState } from 'react';

import { type Navigation } from '../app/nav';
import { host } from '../app/row';
import { useLanguage } from '../i18n/context';
import { type Messages, format, roleName } from '../i18n/messages';
import { Button, Notice, Overflow } from './components';
import { writeError } from './errors';
import { Icon, type IconName } from './icons';
import { Avatar, TEMPLATE_ICON, known } from './ItemRow';
import { SecretView } from './Secret';
import { TotpView } from './Totp';

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

export function FieldValue({
  field,
  name,
  clearSeconds,
}: {
  readonly field: Field;
  readonly name: string;
  readonly clearSeconds: number;
}) {
  const m = useLanguage().messages;
  const { value } = field;
  if (typeof value !== 'string') {
    return <TotpView value={value} name={name} clearSeconds={clearSeconds} />;
  }
  switch (field.type) {
    case 'secret':
      return <SecretView value={value} label={name} clearSeconds={clearSeconds} />;
    case 'seed-phrase':
      return (
        <div className="flex flex-col gap-1">
          <SecretView value={value} label={name} clearSeconds={clearSeconds} words />
          {seedPhraseChecksumValid(value) ? null : (
            <p className="text-sm text-warning">{m.items.checksum}</p>
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

/** A chip of the detail's header (D247): an icon, named when the text alone does not say what it is. */
function Chip({
  icon,
  label,
  text,
}: {
  readonly icon: IconName;
  readonly label?: string;
  readonly text: string;
}) {
  return (
    <li className="inline-flex max-w-full items-center gap-1 rounded-full bg-subtle px-2.5 py-0.5 text-xs">
      <Icon name={icon} {...(label === undefined ? {} : { label })} className="size-3.5!" />
      <span className="truncate">{text}</span>
    </li>
  );
}

/** A titled card of the detail (D247). */
function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="rounded-card border border-line bg-raised shadow-raised"
    >
      <h2 id={id} className="px-4 pt-3 text-xs font-bold tracking-wide text-muted uppercase">
        {title}
      </h2>
      {children}
    </section>
  );
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
  // Not for content from a newer app version, nor in the trash; beyond the future-clock bound
  // it is, since the copy takes a fresh HLC (D140).
  const duplicable = item !== undefined && !view.inTrash && session.writable;

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
  const duplicate = () => {
    setWorking(true);
    setError(undefined);
    const from = nav.current();
    session.duplicateItem(id, m.items.copySuffix).then(
      (copy) => {
        onChange();
        nav.follow(from, () => {
          nav.select({ name: 'item', id: copy });
        });
      },
      (e: unknown) => {
        setWorking(false);
        setError(
          e instanceof ContentInvalidError && e.what === 'title'
            ? m.items.copyTitleTooLong
            : writeError(e, m),
        );
      },
    );
  };

  const clearSeconds = session.preferences.clipboardClearSeconds;
  const template = item !== undefined && known(item.templateId) ? item.templateId : undefined;
  const folder =
    item?.folderId && session.folder(item.folderId)?.inTrash === false
      ? session.folder(item.folderId)?.name
      : undefined;
  const url = item?.fields.find(
    (f) => f.type === 'url' && typeof f.value === 'string' && f.value.trim() !== '',
  )?.value;
  const fields = (list: readonly Field[]) => (
    <dl className="divide-y divide-line">
      {list.map((field, i) => {
        const name = fieldName(m, item ?? { templateId: '' }, field);
        return (
          // Fields have no ID; their order is fixed while the item is shown.
          <div key={i} className="flex flex-col gap-0.5 px-4 py-3">
            <dt className="text-xs font-medium text-muted">{name}</dt>
            <dd>
              <FieldValue field={field} name={name} clearSeconds={clearSeconds} />
            </dd>
          </div>
        );
      })}
    </dl>
  );
  const roles = item?.fields.filter((f) => f.role !== undefined) ?? [];
  const others = item?.fields.filter((f) => f.role === undefined) ?? [];
  const trashable = editable && !view.inTrash;

  return (
    <article className="flex w-full max-w-2xl flex-col gap-4 p-4" aria-label={item?.title}>
      <header className="flex flex-wrap items-start gap-3">
        {item ? <Avatar title={item.title} templateId={item.templateId} large /> : null}
        <div className="flex min-w-0 flex-1 basis-48 flex-col gap-2">
          <h1 className="text-xl font-semibold break-words">{item?.title ?? m.items.newerTitle}</h1>
          {item ? (
            <ul className="flex flex-wrap gap-1.5">
              {template ? (
                <Chip icon={TEMPLATE_ICON[template]} text={m.templates[template]} />
              ) : null}
              {typeof url === 'string' ? <Chip icon="globe" text={host(url.trim())} /> : null}
              {folder !== undefined ? (
                <Chip icon="folder" label={m.folders.folder} text={folder} />
              ) : null}
              {item.tags.map((tag) => (
                <Chip key={tag} icon="tag" label={m.items.tags} text={tag} />
              ))}
            </ul>
          ) : null}
        </div>
        {editable || duplicable ? (
          <div className="ms-auto flex items-center gap-1">
            {!editable ? null : view.inTrash ? (
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
              <Button
                variant="secondary"
                disabled={working}
                onClick={() => {
                  nav.open({ name: 'edit', id });
                }}
              >
                <Icon name="pencil" className="me-1.5" />
                {m.items.edit}
              </Button>
            )}
            {!view.inTrash ? (
              // Out of the trash, History is always there, so the menu is never empty.
              <Overflow label={m.items.moreActions}>
                {duplicable ? (
                  <Button
                    variant="quiet"
                    className="text-left"
                    disabled={working}
                    onClick={duplicate}
                  >
                    <Icon name="copy-plus" className="me-1.5" />
                    {m.items.duplicate}
                  </Button>
                ) : null}
                <Button
                  variant="quiet"
                  className="text-left"
                  onClick={() => {
                    nav.open({ name: 'history', id });
                  }}
                >
                  <Icon name="history" className="me-1.5" />
                  {m.items.history}
                </Button>
                {trashable ? (
                  <Button
                    variant="quiet"
                    className="text-left text-danger!"
                    disabled={working}
                    onClick={() => {
                      act(() => session.trashItem(id));
                    }}
                  >
                    <Icon name="trash-2" className="me-1.5" />
                    {m.items.moveToTrash}
                  </Button>
                ) : null}
              </Overflow>
            ) : null}
          </div>
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
      {roles.length > 0 ? (
        <Section title={template ? m.templates[template] : m.items.otherFields}>
          {fields(roles)}
        </Section>
      ) : null}
      {others.length > 0 ? <Section title={m.items.otherFields}>{fields(others)}</Section> : null}
      {item?.notes !== undefined ? (
        <Section title={m.items.notes}>
          <p className="px-4 pt-1 pb-3 break-words whitespace-pre-wrap">{item.notes}</p>
        </Section>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </article>
  );
}
