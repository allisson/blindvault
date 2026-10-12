// The folder tree, derived at read time (overview §9.3, D14). It never writes: once every device
// holds the same records, every device shows the same tree.

import { type Hlc } from '@blindvault/crypto';

import { compareHlc } from './hlc';
import { idKey } from './ids';
import { compareBytes } from './text';

export interface TreeFolder {
  readonly id: Uint8Array;
  readonly parentId?: Uint8Array;
  readonly hlc: Hlc;
}

/**
 * The displayed parent of every live folder, by `idKey`; `null` is the vault root.
 * - **Orphans:** a folder whose parent is not a live folder here (a tombstone, or not received
 *   yet) is at the root.
 * - **Cycles:** in each cycle, the folder with the greatest `hlc` is at the root.
 */
export function displayedParents(folders: readonly TreeFolder[]): Map<string, string | null> {
  const byKey = new Map(folders.map((f) => [idKey(f.id), f]));
  const parent = new Map<string, string | null>();
  for (const [key, f] of byKey) {
    const p = f.parentId ? idKey(f.parentId) : null;
    parent.set(key, p !== null && byKey.has(p) ? p : null);
  }
  // Walk each chain once: 1 = on the current path, 2 = resolved.
  const state = new Map<string, 1 | 2>();
  for (const first of byKey.values()) {
    const path: TreeFolder[] = [];
    let f: TreeFolder | undefined = first;
    while (f && !state.has(idKey(f.id))) {
      const key = idKey(f.id);
      state.set(key, 1);
      path.push(f);
      const p = parent.get(key);
      f = p ? byKey.get(p) : undefined;
    }
    if (f && state.get(idKey(f.id)) === 1) {
      const cycle = path.slice(path.indexOf(f));
      const top = cycle.reduce((a, b) => (compareHlc(b.hlc, a.hlc) > 0 ? b : a));
      parent.set(idKey(top.id), null);
    }
    for (const g of path) state.set(idKey(g.id), 2);
  }
  return parent;
}

/** Whether `key` is `ancestor` or below it, following `parents`. */
export function isWithin(
  parents: ReadonlyMap<string, string | null>,
  key: string,
  ancestor: string,
): boolean {
  let node: string | null = key;
  while (node !== null) {
    if (node === ancestor) return true;
    node = parents.get(node) ?? null;
  }
  return false;
}

export interface TreeEntry {
  readonly id: Uint8Array;
  /** Folder name or item title, for the alphabetical order. */
  readonly name: string;
}

const ROOT: TreeEntry = { id: new Uint8Array(0), name: '' };

export interface TreeNode<F extends TreeEntry, I extends TreeEntry> {
  /** `null` for the vault root. */
  readonly folder: F | null;
  readonly folders: TreeNode<F, I>[];
  readonly items: I[];
}

/**
 * The displayed tree: every live folder once under its displayed parent, every live item once
 * under its folder when that folder is live here, else at the root. Siblings sort by `compare`
 * on the name (the UI's collation), then by ID bytewise, so every device shows the same order.
 */
export function buildTree<
  F extends TreeEntry & TreeFolder,
  I extends TreeEntry & { readonly folderId?: Uint8Array },
>(folders: readonly F[], items: readonly I[], compare: (a: string, b: string) => number) {
  const parents = displayedParents(folders);
  const nodes = new Map<string, TreeNode<F, I>>();
  for (const f of folders) nodes.set(idKey(f.id), { folder: f, folders: [], items: [] });
  const root: TreeNode<F, I> = { folder: null, folders: [], items: [] };
  for (const [key, node] of nodes) {
    const p = parents.get(key);
    (p ? (nodes.get(p) ?? root) : root).folders.push(node);
  }
  for (const item of items) {
    const node = item.folderId ? nodes.get(idKey(item.folderId)) : undefined;
    (node ?? root).items.push(item);
  }
  const order = (a: TreeEntry, b: TreeEntry) => compare(a.name, b.name) || compareBytes(a.id, b.id);
  const sort = (node: TreeNode<F, I>) => {
    node.folders.sort((a, b) => order(a.folder ?? ROOT, b.folder ?? ROOT));
    node.items.sort(order);
    node.folders.forEach(sort);
  };
  sort(root);
  return root;
}
