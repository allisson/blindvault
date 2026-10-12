import {
  type FolderTree,
  type ItemView,
  type TreeItem,
  type VaultSession,
} from '@blindvault/vault';
import { useSyncExternalStore } from 'react';

import { type Navigation } from '../app/nav';
import { useLanguage } from '../i18n/context';
import { Button, TARGET } from './components';
import { hex } from './ids';

interface Row {
  readonly id: Uint8Array;
  readonly name: string;
}

function flatten(node: FolderTree): TreeItem[] {
  return [...node.items, ...node.folders.flatMap(flatten)];
}

function title(view: ItemView, fallback: string): string {
  return view.item?.title ?? fallback;
}

/** The items of the list shown: every item not in the trash, or the trash. */
export function ItemList({
  session,
  nav,
}: {
  readonly session: VaultSession;
  readonly nav: Navigation;
}) {
  const { messages: m, language } = useLanguage();
  const screen = useSyncExternalStore(nav.subscribe, nav.current);
  const list = useSyncExternalStore(nav.subscribe, nav.list);
  const collator = new Intl.Collator(language);
  const rows: Row[] =
    list === 'trash'
      ? session
          .items()
          .filter((v) => v.inTrash)
          .map((v) => ({ id: v.id, name: title(v, m.items.newerTitle) }))
      : flatten(session.tree(collator.compare)).map((t) => ({
          id: t.id,
          name: t.name === '' ? m.items.newerTitle : t.name,
        }));
  rows.sort((a, b) => collator.compare(a.name, b.name));
  const selected = screen.name === 'item' || screen.name === 'edit' ? hex(screen.id) : undefined;
  const heading = list === 'trash' ? m.vault.trash : m.vault.items;
  return (
    <section aria-label={heading} className="flex flex-col gap-2 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{heading}</h2>
        {list === 'vault' && session.writable ? (
          <Button
            onClick={() => {
              nav.select({ name: 'new' });
            }}
          >
            {m.items.new}
          </Button>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-zinc-500">
          {list === 'trash' ? m.vault.trashEmpty : m.vault.empty}
        </p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((row) => (
            <li key={hex(row.id)}>
              <button
                type="button"
                aria-current={selected === hex(row.id) ? 'true' : undefined}
                className={`${TARGET} w-full truncate rounded-md px-2 text-left text-sm hover:bg-zinc-100 aria-[current]:bg-zinc-200 dark:hover:bg-zinc-800 dark:aria-[current]:bg-zinc-800`}
                onClick={() => {
                  nav.select({ name: 'item', id: row.id });
                }}
              >
                {row.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
