// Search over decrypted state in memory only (D132). The index reads titles, tags, folder names,
// notes and the values of non-secret fields; it never reads `secret`, TOTP or seed-phrase values,
// so it holds no secret and a search cannot confirm a guessed password. Nothing of it is persisted,
// and the shell clears it on lock.

import { type FieldType, type FolderTree } from '@blindvault/vault';

const NEVER_READ: ReadonlySet<FieldType> = new Set(['secret', 'totp', 'seed-phrase']);

/** Compatibility decomposition, marks dropped, lowercase without a locale. */
export function normalizeForSearch(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

interface Entry {
  readonly id: Uint8Array;
  readonly text: string;
}

export class SearchIndex {
  #entries: Entry[] = [];

  get size(): number {
    return this.#entries.length;
  }

  /** Indexes every item of the tree (the trash is not in it), in tree order. */
  build(tree: FolderTree): void {
    const entries: Entry[] = [];
    const walk = (node: FolderTree, path: readonly string[]) => {
      for (const t of node.items) {
        const parts = [t.name, ...path];
        if (t.item) {
          parts.push(...t.item.tags);
          if (t.item.notes !== undefined) parts.push(t.item.notes);
          for (const f of t.item.fields) {
            if (!NEVER_READ.has(f.type) && typeof f.value === 'string') parts.push(f.value);
          }
        }
        entries.push({ id: t.id, text: normalizeForSearch(parts.join('\n')) });
      }
      for (const child of node.folders) {
        walk(child, child.folder ? [...path, child.folder.name] : path);
      }
    };
    walk(tree, []);
    this.#entries = entries;
  }

  /** The IDs whose text holds every whitespace-separated term of `query`. */
  search(query: string): Uint8Array[] {
    const terms = normalizeForSearch(query)
      .split(/\s+/u)
      .filter((t) => t !== '');
    if (terms.length === 0) return [];
    return this.#entries.filter((e) => terms.every((t) => e.text.includes(t))).map((e) => e.id);
  }

  /** The indexed text, for tests. */
  text(): string[] {
    return this.#entries.map((e) => e.text);
  }

  clear(): void {
    this.#entries = [];
  }
}
