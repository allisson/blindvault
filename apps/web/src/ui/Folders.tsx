import { type BlockedRecord, type VaultSession } from '@blindvault/vault';
import { type ReactNode, useState, useSyncExternalStore } from 'react';

import {
  type FolderFailure,
  folderFailure,
  folderNameOf,
  folderRows,
  moveTargets,
} from '../app/folders';
import { hex } from '../app/ids';
import { type ListScreen, type Navigation } from '../app/nav';
import { useLanguage, useMessages } from '../i18n/context';
import { type Messages } from '../i18n/messages';
import { Button, Field, INPUT, Notice } from './components';

function recordName(session: VaultSession, r: BlockedRecord, m: Messages): string {
  const folder = session.folder(r.recordId);
  if (folder) return folder.name;
  return session.item(r.recordId)?.item?.title ?? m.items.newerTitle;
}

export function FailureMessage({
  session,
  failure,
}: {
  readonly session: VaultSession;
  readonly failure: FolderFailure | undefined;
}) {
  const m = useMessages();
  if (!failure) return null;
  return (
    <div role="alert" className="flex flex-col gap-1 text-sm text-red-700 dark:text-red-400">
      {failure.kind === 'message' ? (
        <p>{failure.text}</p>
      ) : (
        <>
          <p>{m.folders.blocked}</p>
          <ul className="list-disc pl-5">
            {failure.records.map((r) => (
              <li key={hex(r.recordId)}>
                {recordName(session, r, m)}:{' '}
                {r.reason === 'future-clock'
                  ? m.folders['future-clock']
                  : m.folders['newer-content']}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** A one-field form for a folder name: create or rename. */
function NameForm({
  initial,
  submit,
  onDone,
  session,
}: {
  readonly initial: string;
  readonly submit: (name: string) => Promise<unknown>;
  readonly onDone: () => void;
  readonly session: VaultSession;
}) {
  const m = useMessages();
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string>();
  const [failure, setFailure] = useState<FolderFailure>();
  return (
    <form
      noValidate
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const result = folderNameOf(name);
        if (!result.ok) {
          setError(
            result.error === 'required'
              ? m.folders.nameRequired
              : result.error === 'too-long'
                ? m.folders.nameTooLong
                : m.folders.nameSingleLine,
          );
          return;
        }
        submit(result.name).then(onDone, (err: unknown) => {
          setFailure(folderFailure(err, m));
        });
      }}
    >
      <Field
        label={m.folders.name}
        value={name}
        error={error}
        autoFocus
        onChange={(e) => {
          setName(e.target.value);
          setError(undefined);
        }}
        data-testid="folder-name"
      />
      <FailureMessage session={session} failure={failure} />
      <div className="flex gap-2">
        <Button type="submit">{initial === '' ? m.folders.create : m.folders.rename}</Button>
        <Button variant="quiet" onClick={onDone}>
          {m.items.cancel}
        </Button>
      </div>
    </form>
  );
}

function ListEntry({
  nav,
  list,
  depth = 0,
  children,
}: {
  readonly nav: Navigation;
  readonly list: ListScreen;
  readonly depth?: number;
  readonly children: ReactNode;
}) {
  const current = useSyncExternalStore(nav.subscribe, nav.list);
  const selected =
    current.name === list.name &&
    (current.name !== 'folder' || list.name !== 'folder' || hex(current.id) === hex(list.id));
  return (
    <Button
      variant="quiet"
      className="justify-start truncate text-left aria-[current]:bg-zinc-100 dark:aria-[current]:bg-zinc-800"
      style={{ paddingLeft: `${String(1 + depth)}rem` }}
      aria-current={selected ? 'true' : undefined}
      onClick={() => {
        nav.showList(list);
      }}
    >
      {children}
    </Button>
  );
}

/** All items, the folder tree as derived (D14), and the trash. */
export function FolderPane({
  session,
  nav,
  onChange,
}: {
  readonly session: VaultSession;
  readonly nav: Navigation;
  readonly onChange: () => void;
}) {
  const { messages: m, language } = useLanguage();
  const [creating, setCreating] = useState(false);
  const rows = folderRows(session.tree(new Intl.Collator(language).compare));
  return (
    <nav aria-label={m.vault.folders} className="flex flex-col gap-1 p-3">
      <h2 className="px-2 text-xs font-semibold uppercase text-zinc-500">{m.vault.folders}</h2>
      <ListEntry nav={nav} list={{ name: 'vault' }}>
        {m.vault.allItems}
      </ListEntry>
      {rows.map(({ folder, depth }) => (
        <ListEntry
          key={hex(folder.id)}
          nav={nav}
          list={{ name: 'folder', id: folder.id }}
          depth={depth + 1}
        >
          {folder.name}
        </ListEntry>
      ))}
      <ListEntry nav={nav} list={{ name: 'trash' }}>
        {m.vault.trash}
      </ListEntry>
      {session.writable ? (
        creating ? (
          <NameForm
            initial=""
            session={session}
            submit={(name) =>
              session.createFolder(name).then((id) => {
                onChange();
                nav.showList({ name: 'folder', id });
              })
            }
            onDone={() => {
              setCreating(false);
            }}
          />
        ) : (
          <Button
            variant="quiet"
            className="text-left"
            onClick={() => {
              setCreating(true);
            }}
          >
            + {m.folders.new}
          </Button>
        )
      ) : null}
    </nav>
  );
}

type Action = 'none' | 'subfolder' | 'rename' | 'move';

/** The actions of the folder shown as the list: new subfolder, rename, move, trash. */
export function FolderActions({
  session,
  nav,
  id,
  onChange,
}: {
  readonly session: VaultSession;
  readonly nav: Navigation;
  readonly id: Uint8Array;
  readonly onChange: () => void;
}) {
  const { messages: m, language } = useLanguage();
  const [action, setAction] = useState<Action>('none');
  const [failure, setFailure] = useState<FolderFailure>();
  const [target, setTarget] = useState<string>();
  const folder = session.folder(id);
  if (!folder || folder.inTrash) return null;
  const tree = session.tree(new Intl.Collator(language).compare);
  const editable = session.writable && folder.readOnly === undefined;
  const done = () => {
    setAction('none');
  };
  const run = (write: Promise<unknown>, after: () => void) => {
    setFailure(undefined);
    write.then(
      () => {
        onChange();
        after();
      },
      (err: unknown) => {
        setFailure(folderFailure(err, m));
      },
    );
  };
  if (!editable) {
    return folder.readOnly === 'future-clock' ? <Notice>{m.items.readOnlyClock}</Notice> : null;
  }
  const targets = moveTargets(tree, id);
  const stored = folder.parentId ? hex(folder.parentId) : '';
  // An orphan shown at the root (D14) starts from the root.
  const parent = targets.some((t) => t.folder && hex(t.folder.id) === stored) ? stored : '';
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1">
        {(['subfolder', 'rename', 'move'] as const).map((a) => (
          <Button
            key={a}
            variant="quiet"
            aria-expanded={action === a}
            onClick={() => {
              setFailure(undefined);
              setAction(action === a ? 'none' : a);
              setTarget(parent);
            }}
          >
            {a === 'subfolder'
              ? m.folders.newSubfolder
              : a === 'rename'
                ? m.folders.rename
                : m.folders.move}
          </Button>
        ))}
        <Button
          variant="quiet"
          title={m.folders.trashNote}
          onClick={() => {
            run(session.trashFolder(id), () => {
              nav.closeFolder(id);
            });
          }}
        >
          {m.items.moveToTrash}
        </Button>
      </div>
      {action === 'subfolder' ? (
        <NameForm
          initial=""
          session={session}
          submit={(name) =>
            session.createFolder(name, id).then((child) => {
              onChange();
              nav.showList({ name: 'folder', id: child });
            })
          }
          onDone={done}
        />
      ) : null}
      {action === 'rename' ? (
        <NameForm
          initial={folder.name}
          session={session}
          submit={(name) => session.renameFolder(id, name).then(onChange)}
          onDone={done}
        />
      ) : null}
      {action === 'move' ? (
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const to = targets.find((t) => (t.folder ? hex(t.folder.id) : '') === target);
            if (!to) return;
            run(session.moveFolder(id, to.folder?.id), done);
          }}
        >
          <label className="flex flex-1 flex-col gap-1 text-sm font-medium">
            {m.folders.moveTo}
            <select
              className={INPUT}
              value={target}
              onChange={(e) => {
                setTarget(e.target.value);
              }}
              data-testid="move-target"
            >
              {targets.map((t) => (
                <option
                  key={t.folder ? hex(t.folder.id) : ''}
                  value={t.folder ? hex(t.folder.id) : ''}
                >
                  {t.folder ? `${'  '.repeat(t.depth)}${t.folder.name}` : m.folders.root}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit">{m.folders.move}</Button>
        </form>
      ) : null}
      <FailureMessage session={session} failure={failure} />
    </div>
  );
}

/** A folder in the trash: restore only (D143), with what it brings back. */
export function TrashedFolder({
  session,
  id,
  name,
  onChange,
}: {
  readonly session: VaultSession;
  readonly id: Uint8Array;
  readonly name: string;
  readonly onChange: () => void;
}) {
  const m = useMessages();
  const [failure, setFailure] = useState<FolderFailure>();
  const folder = session.folder(id);
  const restorable = session.writable && folder?.readOnly === undefined;
  return (
    <div className="flex flex-col gap-1 px-2 py-1">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm">
          <span className="text-zinc-500">{m.folders.folder}: </span>
          {name}
        </span>
        {restorable ? (
          <Button
            variant="quiet"
            title={m.folders.restoreNote}
            aria-label={`${m.items.restore} ${name}`}
            onClick={() => {
              setFailure(undefined);
              session.restoreFolder(id).then(onChange, (err: unknown) => {
                setFailure(folderFailure(err, m));
              });
            }}
          >
            {m.items.restore}
          </Button>
        ) : null}
      </div>
      <FailureMessage session={session} failure={failure} />
    </div>
  );
}
