import { type Item, type TreeItem, type VaultSession } from '@blindvault/vault';
import { type ReactNode, type RefObject, useRef, useState, useSyncExternalStore } from 'react';

import { findNode, treeItems } from '../app/folders';
import { hex } from '../app/ids';
import { type Navigation } from '../app/nav';
import { letter } from '../app/row';
import { type SearchIndex } from '../app/search';
import { listMove } from '../app/shortcuts';
import { useLanguage } from '../i18n/context';
import { type Messages } from '../i18n/messages';
import { Button, INPUT, Pill, ROW } from './components';
import { useLayout } from './hooks';
import { Icon } from './icons';
import { FirstSteps } from './FirstSteps';
import { FolderActions, FolderPane, TrashedFolder } from './Folders';
import { ItemRow } from './ItemRow';
import { useCopy } from './Secret';

interface Row {
  readonly id: Uint8Array;
  readonly name: string;
  /** Its template, unless the item is from a newer app version. */
  readonly type?: string | undefined;
  /** Its content, unless the item is from a newer app version. */
  readonly item?: Item | undefined;
}

type Template = keyof Messages['templates'];

/** The list shown: every item not in the trash, one folder's contents, or the trash. */
export function ItemList({
  session,
  nav,
  onChange,
  index,
  query,
  onQuery,
  searchRef,
  notice,
}: {
  readonly session: VaultSession;
  readonly nav: Navigation;
  readonly onChange: () => void;
  readonly index: SearchIndex;
  readonly query: string;
  readonly onQuery: (query: string) => void;
  readonly searchRef: RefObject<HTMLInputElement | null>;
  /** Shown below the list's head, such as the backup reminder (D254). */
  readonly notice?: ReactNode;
}) {
  const { messages: m, language } = useLanguage();
  const layout = useLayout();
  // In memory, kept across lists; a type the list shown lacks falls back to all (D245).
  const [type, setType] = useState<Template>();
  const { copy } = useCopy(session.preferences.clipboardClearSeconds);
  const screen = useSyncExternalStore(nav.subscribe, nav.current);
  const list = useSyncExternalStore(nav.subscribe, nav.list);
  const rowsRef = useRef<HTMLUListElement>(null);
  // The items' own buttons, in the order shown; a row's Copy is reached with Tab.
  const rows = () => [...(rowsRef.current?.querySelectorAll<HTMLElement>('[data-row]') ?? [])];
  const collator = new Intl.Collator(language);
  const tree = session.tree(collator.compare);
  const named = (t: TreeItem): Row => ({
    id: t.id,
    name: t.name === '' ? m.items.newerTitle : t.name,
    type: t.item?.templateId,
    item: t.item,
  });

  let heading = m.vault.items;
  // All items with nothing in them shows the first steps (D250).
  let empty: string | undefined;
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
        item: v.item,
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
  // Applied only while its pill shows, so no item is ever hidden by a filter out of sight.
  const filter = types.length > 1 && type !== undefined && counts.has(type) ? type : undefined;
  const all = items.length;
  if (filter !== undefined) items = items.filter((row) => row.type === filter);
  const nothing = items.length + subfolders.length + trashedFolders.length === 0;
  // On a phone the folders are a pill's sheet, not a screen of their own (D254).
  const folderPill = layout === 'mobile' && list.name !== 'trash';
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
              <Icon name="plus" className="me-2" />
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
            onKeyDown={(e) => {
              // ↓ moves into the list; Esc clears the search, in every browser (D251).
              if (e.key === 'ArrowDown' && !e.altKey) {
                const first = rows()[0];
                if (!first) return;
                e.preventDefault();
                first.focus();
              } else if (e.key === 'Escape' && query !== '') {
                e.preventDefault();
                onQuery('');
              }
            }}
            data-testid="search"
          />
        ) : null}
        {folderPill || types.length > 1 ? (
          <div className="flex gap-2">
            {folderPill ? (
              <Pill
                // A new list closes the sheet, a folder just created included.
                key={list.name === 'folder' ? hex(list.id) : list.name}
                data-testid="folder-pill"
                icon="folder"
                label={
                  list.name === 'folder'
                    ? (findNode(tree, list.id)?.folder?.name ?? m.vault.allFolders)
                    : m.vault.allFolders
                }
                on={list.name === 'folder'}
              >
                <FolderPane session={session} nav={nav} onChange={onChange} />
              </Pill>
            ) : null}
            {types.length > 1 ? (
              <Pill
                data-testid="type-pill"
                label={filter === undefined ? m.vault.allTypes : m.templates[filter]}
                on={filter !== undefined}
              >
                {/* The counts are seen only: the list read next announces its length (D245). */}
                <div role="group" aria-label={m.vault.filterType} className="flex flex-col gap-1">
                  {/* A sheet is titled, as the folders' (D254). */}
                  {layout === 'mobile' ? (
                    <h2
                      aria-hidden="true"
                      className="px-2 py-1 text-label font-semibold text-muted uppercase"
                    >
                      {m.vault.filterType}
                    </h2>
                  ) : null}
                  {[undefined, ...types].map((t) => (
                    <button
                      key={t ?? ''}
                      type="button"
                      data-choice
                      className={`${ROW} flex items-center justify-between gap-4 aria-pressed:bg-accent-soft aria-pressed:font-medium`}
                      aria-pressed={filter === t}
                      onClick={() => {
                        setType(t);
                      }}
                    >
                      {t === undefined ? m.vault.allTypes : m.templates[t]}
                      <span aria-hidden="true" className="text-xs text-muted">
                        {t === undefined ? all : counts.get(t)}
                      </span>
                    </button>
                  ))}
                </div>
              </Pill>
            ) : null}
          </div>
        ) : null}
      </div>
      {notice}
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
      {!nothing ? null : empty === undefined ? (
        <FirstSteps session={session} nav={nav} />
      ) : (
        <p className="text-sm text-muted">{empty}</p>
      )}
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
        <ul
          ref={rowsRef}
          className="flex flex-col"
          onKeyDown={(e) => {
            // ↑/↓ and J/K move between the rows; above the first is the search (D251).
            const move = listMove(e);
            const { target } = e;
            if (move === undefined || !(target instanceof HTMLElement)) return;
            const all = rows();
            const at = all.findIndex((row) => row.closest('li') === target.closest('li'));
            if (at < 0) return;
            e.preventDefault();
            const next = at + move;
            if (next < 0) searchRef.current?.focus();
            else all[next]?.focus();
          }}
        >
          {items.flatMap((row, i) => {
            const id = hex(row.id);
            const group = letter(row.name);
            const entry = (
              <li key={id}>
                <ItemRow
                  name={row.name}
                  item={row.item}
                  selected={selected === id}
                  onSelect={() => {
                    nav.select({ name: 'item', id: row.id });
                  }}
                  onCopy={copy}
                />
              </li>
            );
            // On a phone, items fall under their first letter; seen only, as the list is read.
            return layout === 'mobile' && (i === 0 || letter(items[i - 1]?.name ?? '') !== group)
              ? [
                  <li
                    key={`letter-${id}`}
                    aria-hidden="true"
                    className="px-2 pt-3 pb-1 text-xs font-semibold text-muted"
                  >
                    {group}
                  </li>,
                  entry,
                ]
              : [entry];
          })}
        </ul>
      ) : null}
    </section>
  );
}
