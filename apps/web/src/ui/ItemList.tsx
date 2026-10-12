import { type FolderTree, type TreeItem, type VaultSession } from '@blindvault/vault';
import { type RefObject, useSyncExternalStore } from 'react';

import { findNode } from '../app/folders';
import { hex } from '../app/ids';
import { type Navigation } from '../app/nav';
import { type SearchIndex } from '../app/search';
import { useLanguage } from '../i18n/context';
import { Button, INPUT, TARGET } from './components';
import { FolderActions, TrashedFolder } from './Folders';

interface Row {
  readonly id: Uint8Array;
  readonly name: string;
}

function flatten(node: FolderTree): TreeItem[] {
  return [...node.items, ...node.folders.flatMap(flatten)];
}

const ROW = `${TARGET} w-full truncate rounded-md px-2 text-left text-sm hover:bg-zinc-100 aria-[current]:bg-zinc-200 dark:hover:bg-zinc-800 dark:aria-[current]:bg-zinc-800`;

/** The list shown: every item not in the trash, one folder's contents, or the trash. */
export function ItemList({
  session,
  nav,
  onChange,
  index,
  query,
  onQuery,
  searchRef,
}: {
  readonly session: VaultSession;
  readonly nav: Navigation;
  readonly onChange: () => void;
  readonly index: SearchIndex;
  readonly query: string;
  readonly onQuery: (query: string) => void;
  readonly searchRef: RefObject<HTMLInputElement | null>;
}) {
  const { messages: m, language } = useLanguage();
  const screen = useSyncExternalStore(nav.subscribe, nav.current);
  const list = useSyncExternalStore(nav.subscribe, nav.list);
  const collator = new Intl.Collator(language);
  const tree = session.tree(collator.compare);
  const named = (t: TreeItem): Row => ({
    id: t.id,
    name: t.name === '' ? m.items.newerTitle : t.name,
  });

  let heading = m.vault.items;
  let empty = m.vault.empty;
  let items: Row[];
  let subfolders: Row[] = [];
  let trashedFolders: Row[] = [];
  const searching = list.name !== 'trash' && query.trim() !== '';
  // Nothing stays indexed while no search runs.
  if (!searching) index.clear();
  if (searching) {
    // Across every item, whatever folder is shown (D132).
    heading = m.vault.results;
    empty = m.vault.noResults;
    index.build(tree);
    const found = new Set(index.search(query).map(hex));
    items = flatten(tree)
      .filter((t) => found.has(hex(t.id)))
      .map(named);
    items.sort((a, b) => collator.compare(a.name, b.name));
  } else if (list.name === 'trash') {
    heading = m.vault.trash;
    empty = m.vault.trashEmpty;
    items = session
      .items()
      .filter((v) => v.inTrash)
      .map((v) => ({ id: v.id, name: v.item?.title ?? m.items.newerTitle }));
    trashedFolders = session
      .folders()
      .filter((f) => f.inTrash)
      .map((f) => ({ id: f.id, name: f.name }));
    items.sort((a, b) => collator.compare(a.name, b.name));
    trashedFolders.sort((a, b) => collator.compare(a.name, b.name));
  } else if (list.name === 'folder') {
    const node = findNode(tree, list.id);
    heading = node?.folder?.name ?? m.vault.items;
    empty = m.folders.empty;
    // The tree is already in display order (D14).
    items = (node?.items ?? []).map(named);
    subfolders = (node?.folders ?? []).flatMap((n) =>
      n.folder ? [{ id: n.folder.id, name: n.folder.name }] : [],
    );
  } else {
    items = flatten(tree).map(named);
    items.sort((a, b) => collator.compare(a.name, b.name));
  }
  const selected = screen.name === 'item' || screen.name === 'edit' ? hex(screen.id) : undefined;
  const nothing = items.length + subfolders.length + trashedFolders.length === 0;
  return (
    <section aria-label={heading} className="flex min-w-0 flex-col gap-2 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="truncate text-sm font-semibold">{heading}</h2>
        {list.name !== 'trash' && session.writable ? (
          <Button
            onClick={() => {
              nav.select({ name: 'new' });
            }}
          >
            {m.items.new}
          </Button>
        ) : null}
      </div>
      {list.name !== 'trash' ? (
        <input
          ref={searchRef}
          type="search"
          aria-label={m.vault.search}
          title={m.vault.searchHint}
          placeholder={`${m.vault.search} (Ctrl/⌘ K)`}
          autoComplete="off"
          spellCheck={false}
          className={INPUT}
          value={query}
          onChange={(e) => {
            onQuery(e.target.value);
          }}
          data-testid="search"
        />
      ) : null}
      {list.name === 'folder' && !searching ? (
        <FolderActions
          // Keyed by folder: an open form never carries to another folder.
          key={hex(list.id)}
          session={session}
          nav={nav}
          id={list.id}
          onChange={onChange}
        />
      ) : null}
      {nothing ? <p className="text-sm text-zinc-500">{empty}</p> : null}
      {subfolders.length > 0 ? (
        <ul className="flex flex-col" aria-label={m.vault.folders}>
          {subfolders.map((row) => (
            <li key={hex(row.id)}>
              <button
                type="button"
                className={`${ROW} font-medium`}
                onClick={() => {
                  nav.showList({ name: 'folder', id: row.id });
                }}
              >
                ▸ {row.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {trashedFolders.length > 0 ? (
        <ul className="flex flex-col">
          {trashedFolders.map((row) => (
            <li key={hex(row.id)}>
              <TrashedFolder session={session} id={row.id} name={row.name} onChange={onChange} />
            </li>
          ))}
        </ul>
      ) : null}
      {items.length > 0 ? (
        <ul className="flex flex-col">
          {items.map((row) => (
            <li key={hex(row.id)}>
              <button
                type="button"
                aria-current={selected === hex(row.id) ? 'true' : undefined}
                className={ROW}
                onClick={() => {
                  nav.select({ name: 'item', id: row.id });
                }}
              >
                {row.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
