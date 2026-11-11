import { type TreeItem, type VaultSession } from '@blindvault/vault';
import { type RefObject, useState, useSyncExternalStore } from 'react';

import { findNode, treeItems } from '../app/folders';
import { hex } from '../app/ids';
import { type Navigation } from '../app/nav';
import { type SearchIndex } from '../app/search';
import { useLanguage } from '../i18n/context';
import { type Messages } from '../i18n/messages';
import { Button, INPUT, ROW, TARGET } from './components';
import { useLayout } from './hooks';
import { Icon } from './icons';
import { FolderActions, TrashedFolder } from './Folders';

interface Row {
  readonly id: Uint8Array;
  readonly name: string;
  /** Its template, unless the item is from a newer app version. */
  readonly type?: string | undefined;
}

type Template = keyof Messages['templates'];

/** A type filter's chip; the pressed one takes the accent's soft fill (D245). */
const CHIP = `${TARGET} shrink-0 whitespace-nowrap rounded-full border border-line px-3 text-sm hover:bg-subtle aria-pressed:border-accent aria-pressed:bg-accent-soft aria-pressed:font-medium`;

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
  const layout = useLayout();
  // In memory, kept across lists; a type the list shown lacks falls back to all (D245).
  const [type, setType] = useState<Template>();
  const screen = useSyncExternalStore(nav.subscribe, nav.current);
  const list = useSyncExternalStore(nav.subscribe, nav.list);
  const collator = new Intl.Collator(language);
  const tree = session.tree(collator.compare);
  const named = (t: TreeItem): Row => ({
    id: t.id,
    name: t.name === '' ? m.items.newerTitle : t.name,
    type: t.item?.templateId,
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
    items = treeItems(tree)
      .filter((t) => found.has(hex(t.id)))
      .map(named);
    items.sort((a, b) => collator.compare(a.name, b.name));
  } else if (list.name === 'trash') {
    heading = m.vault.trash;
    empty = m.vault.trashEmpty;
    items = session
      .items()
      .filter((v) => v.inTrash)
      .map((v) => ({
        id: v.id,
        name: v.item?.title ?? m.items.newerTitle,
        type: v.item?.templateId,
      }));
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
    items = treeItems(tree).map(named);
    items.sort((a, b) => collator.compare(a.name, b.name));
  }
  const selected =
    screen.name === 'item' || screen.name === 'edit' || screen.name === 'history'
      ? hex(screen.id)
      : undefined;
  const counts = new Map<string, number>();
  for (const { type: t } of items) if (t !== undefined) counts.set(t, (counts.get(t) ?? 0) + 1);
  // In the templates' order; an unknown template is counted in All only.
  const types = (Object.keys(m.templates) as Template[]).filter((t) => counts.has(t));
  // Applied only while its chips show, so no item is ever hidden by a filter out of sight.
  const filter = types.length > 1 && type !== undefined && counts.has(type) ? type : undefined;
  const all = items.length;
  if (filter !== undefined) items = items.filter((row) => row.type === filter);
  const nothing = items.length + subfolders.length + trashedFolders.length === 0;
  return (
    <section aria-label={heading} className="flex min-w-0 flex-col gap-2 p-4">
      {/* Stays at the top of its scrolling pane, so New item and search are always at hand. */}
      <div className="sticky top-0 z-10 -mx-4 -mt-4 flex flex-col gap-2 bg-surface px-4 pt-4 pb-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="truncate text-sm font-semibold">{heading}</h2>
          {/* On mobile, New item is the header's action (D245). */}
          {list.name !== 'trash' && session.writable && layout !== 'mobile' ? (
            <Button
              title={`${m.items.new} (N)`}
              aria-keyshortcuts="N"
              onClick={() => {
                nav.select({ name: 'new' });
              }}
            >
              <Icon name="plus" className="me-1.5" />
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
            aria-keyshortcuts="Control+K Meta+K"
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
        {types.length > 1 ? (
          // The counts are seen only: the list read next announces its length (D245).
          <div
            role="group"
            aria-label={m.vault.filterType}
            className="-mx-4 flex gap-1 overflow-x-auto px-4"
          >
            {[undefined, ...types].map((t) => (
              <button
                key={t ?? ''}
                type="button"
                className={CHIP}
                aria-pressed={filter === t}
                onClick={() => {
                  setType(t);
                }}
              >
                {t === undefined ? m.vault.allTypes : m.templates[t]}
                <span aria-hidden="true" className="ms-1.5 text-xs">
                  {t === undefined ? all : counts.get(t)}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
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
      {nothing ? <p className="text-sm text-muted">{empty}</p> : null}
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
                <Icon name="folder" className="me-2 text-muted" />
                {row.name}
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
