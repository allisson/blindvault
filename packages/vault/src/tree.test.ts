import { type Hlc } from '@blindvault/crypto';
import { describe, expect, it } from 'vitest';

import { compareHlc } from './hlc';
import { idKey } from './ids';
import { type TreeNode, buildTree, displayedParents, isWithin } from './tree';
import { compareCodePoints } from './text';

/** A small deterministic PRNG (mulberry32), so a failing case can be replayed by its seed. */
function prng(seed: number): (n: number) => number {
  let a = seed >>> 0;
  return (n) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * n;
  };
}

function id(n: number): Uint8Array {
  const out = new Uint8Array(16);
  out[14] = n >> 8;
  out[15] = n & 0xff;
  return out;
}

function hlc(physicalMs: number, device = 1, counter = 0): Hlc {
  return { physicalMs, counter, deviceId: new Uint8Array(16).fill(device) };
}

interface F {
  readonly id: Uint8Array;
  readonly parentId?: Uint8Array;
  readonly hlc: Hlc;
  readonly name: string;
}

interface I {
  readonly id: Uint8Array;
  readonly folderId?: Uint8Array;
  readonly name: string;
}

function folder(n: number, parent: number | undefined, at: number, name = `f${String(n)}`): F {
  return {
    id: id(n),
    ...(parent !== undefined ? { parentId: id(parent) } : {}),
    hlc: hlc(at),
    name,
  };
}

/** Random folders: parents among themselves (cycles likely), missing IDs (orphans) or the root. */
function randomForest(seed: number) {
  const r = prng(seed);
  const n = 1 + Math.floor(r(25));
  const folders: F[] = [];
  for (let i = 0; i < n; i++) {
    const roll = r(10);
    const parent = roll < 7 ? Math.floor(r(n)) : roll < 8.5 ? 1000 + Math.floor(r(5)) : undefined;
    // Two writes never share an HLC (D19): the counter keeps them distinct.
    const f = folder(i, parent, 0, `n${String(Math.floor(r(4)))}`);
    folders.push({ ...f, hlc: hlc(Math.floor(r(4)), 1, i) });
  }
  const items: I[] = [];
  for (let i = 0; i < Math.floor(r(30)); i++) {
    const roll = r(10);
    const folderId = roll < 7 ? id(Math.floor(r(n))) : roll < 8.5 ? id(2000) : undefined;
    items.push({ id: id(3000 + i), ...(folderId ? { folderId } : {}), name: 'item' });
  }
  return { folders, items };
}

function shuffle<T>(values: readonly T[], r: (n: number) => number): T[] {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r(i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

function flatten(node: TreeNode<F, I>): F[] {
  return node.folders.flatMap((child) => [
    ...(child.folder ? [child.folder] : []),
    ...flatten(child),
  ]);
}

function allItems(node: TreeNode<F, I>): I[] {
  return [...node.items, ...node.folders.flatMap(allItems)];
}

const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

describe('folder tree (overview §9.3, D14)', () => {
  it('puts a folder whose parent is missing at the root', () => {
    const parents = displayedParents([folder(1, 99, 5), folder(2, 1, 5)]);
    expect(parents.get(idKey(id(1)))).toBeNull();
    expect(parents.get(idKey(id(2)))).toBe(idKey(id(1)));
  });

  it('breaks a cycle at the folder with the greatest hlc, and the chains into it', () => {
    // 1 → 2 → 3 → 1, and 4 → 3. Folder 2 has the greatest hlc.
    const parents = displayedParents([
      folder(1, 2, 10),
      folder(2, 3, 30),
      folder(3, 1, 20),
      folder(4, 3, 99),
    ]);
    expect(parents.get(idKey(id(2)))).toBeNull();
    expect(parents.get(idKey(id(1)))).toBe(idKey(id(2)));
    expect(parents.get(idKey(id(3)))).toBe(idKey(id(1)));
    expect(parents.get(idKey(id(4)))).toBe(idKey(id(3)));
  });

  it('breaks a self-parented folder and a tie by deviceId', () => {
    const tie: F[] = [
      { ...folder(1, 2, 5), hlc: hlc(5, 1) },
      { ...folder(2, 1, 5), hlc: hlc(5, 2) },
    ];
    const parents = displayedParents([folder(7, 7, 1), ...tie]);
    expect(parents.get(idKey(id(7)))).toBeNull();
    expect(parents.get(idKey(id(2)))).toBeNull();
    expect(parents.get(idKey(id(1)))).toBe(idKey(id(2)));
  });

  it('sorts siblings by name, then by ID', () => {
    const root = buildTree(
      [folder(3, undefined, 1, 'b'), folder(2, undefined, 1, 'a'), folder(1, undefined, 1, 'b')],
      [
        { id: id(9), name: 'z' },
        { id: id(8), name: 'y' },
      ],
      compareCodePoints,
    );
    expect(root.folders.map((n) => n.folder?.id[15])).toEqual([2, 1, 3]);
    expect(root.items.map((i) => i.id[15])).toEqual([8, 9]);
  });

  it.each(SEEDS)('holds every rule on random trees (seed %i)', (seed) => {
    const { folders, items } = randomForest(seed);
    const parents = displayedParents(folders);
    const byKey = new Map(folders.map((f) => [idKey(f.id), f]));

    for (const f of folders) {
      const key = idKey(f.id);
      const shown = parents.get(key);
      // The displayed parent is the stored one or the root, never another folder.
      if (shown !== null) expect(shown).toBe(f.parentId && idKey(f.parentId));
      // Every chain reaches the root: no cycle survives.
      let node: string | null | undefined = key;
      for (let steps = 0; typeof node === 'string'; steps++) {
        expect(steps).toBeLessThanOrEqual(folders.length);
        node = parents.get(node);
      }
      expect(node).toBeNull();
      // A folder whose live parent is not shown sits in a stored cycle and wins its hlc.
      if (shown === null && f.parentId && byKey.has(idKey(f.parentId))) {
        const cycle: F[] = [f];
        let next = byKey.get(idKey(f.parentId));
        while (next && next !== f && cycle.length <= folders.length) {
          cycle.push(next);
          next = next.parentId ? byKey.get(idKey(next.parentId)) : undefined;
        }
        expect(next).toBe(f);
        for (const g of cycle) expect(compareHlc(g.hlc, f.hlc)).toBeLessThanOrEqual(0);
      }
      expect(isWithin(parents, key, key)).toBe(true);
    }

    const root = buildTree(folders, items, compareCodePoints);
    const shownFolders = flatten(root);
    // Every folder and every item is shown exactly once.
    expect(shownFolders.map((f) => idKey(f.id)).sort()).toEqual(
      folders.map((f) => idKey(f.id)).sort(),
    );
    expect(
      allItems(root)
        .map((i) => idKey(i.id))
        .sort(),
    ).toEqual(items.map((i) => idKey(i.id)).sort());

    // The same records in another order give the same tree.
    const again = buildTree(
      shuffle(folders, prng(seed + 1)),
      shuffle(items, prng(seed + 2)),
      compareCodePoints,
    );
    const shape = (n: TreeNode<F, I>): unknown => ({
      f: n.folder ? idKey(n.folder.id) : null,
      i: n.items.map((x) => idKey(x.id)),
      c: n.folders.map(shape),
    });
    expect(shape(again)).toEqual(shape(root));
  });
});
