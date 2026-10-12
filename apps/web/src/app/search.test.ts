import { type FolderTree, type FolderView, type Item, type TreeItem } from '@blindvault/vault';
import { describe, expect, it } from 'vitest';

import { SearchIndex, normalizeForSearch } from './search';

const HLC = { physicalMs: 1, counter: 0, deviceId: new Uint8Array(16) };

function folder(n: number, name: string): FolderView {
  return { id: new Uint8Array(16).fill(n), hlc: HLC, name, inTrash: false, unknownKeys: [] };
}

function entry(n: number, item: Item | undefined, name = item?.title ?? ''): TreeItem {
  return {
    id: new Uint8Array(16).fill(n),
    hlc: HLC,
    inTrash: false,
    name,
    ...(item ? { item } : {}),
  };
}

const bank: Item = {
  templateId: 'login',
  templateVersion: 1,
  title: 'Harbor Credit Union',
  fields: [
    { type: 'text', role: 'username', value: 'ana.lima' },
    { type: 'secret', role: 'password', value: 'Tulip-Orbit-5528' },
    { type: 'url', role: 'url', value: 'https://harbor.example' },
    { type: 'text', label: 'Branch code', value: '0042' },
    {
      type: 'totp',
      label: '2FA',
      value: { secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30 },
    },
  ],
  tags: ['Finance'],
  notes: 'Árvore de Natal',
};

const wallet: Item = {
  templateId: 'crypto-wallet',
  templateVersion: 1,
  title: 'Cold wallet',
  fields: [{ type: 'seed-phrase', role: 'seedPhrase', value: `${'abandon '.repeat(11)}about` }],
  tags: [],
};

// root ─ Work ─ Clients ─ bank
//      └ wallet, newer
const tree: FolderTree = {
  folder: null,
  folders: [
    {
      folder: folder(1, 'Work'),
      folders: [{ folder: folder(2, 'Clients'), folders: [], items: [entry(10, bank)] }],
      items: [],
    },
  ],
  items: [entry(11, wallet), entry(12, undefined, 'From a newer app')],
};

function ids(index: SearchIndex, query: string): number[] {
  return index.search(query).map((id) => Number(id[0]));
}

describe('search in memory (D132)', () => {
  const index = new SearchIndex();
  index.build(tree);

  it.each([
    ['the title', 'credit union', [10]],
    ['a tag', 'finance', [10]],
    ['a folder on the path', 'clients', [10]],
    ['an outer folder', 'work', [10]],
    ['the notes, ignoring case and accents', 'arvore natal', [10]],
    ['a non-secret field value', 'ana.lima', [10]],
    ['a URL', 'harbor.example', [10]],
    ['the title of an item from a newer app', 'newer', [12]],
    ['every term, in any order', 'union harbor', [10]],
  ])('finds %s', (_name, query, expected) => {
    expect(ids(index, query)).toEqual(expected);
  });

  it.each([
    ['a secret value', 'Tulip-Orbit'],
    ['part of a secret value', '5528'],
    ['a TOTP secret', 'JBSWY3DP'],
    ['a seed-phrase word', 'abandon'],
    ['a term missing from the item', 'harbor wallet'],
  ])('never matches %s', (_name, query) => {
    expect(ids(index, query)).toEqual([]);
  });

  it('holds no secret, TOTP or seed-phrase value in its text', () => {
    const text = index.text();
    for (const secret of ['tulip-orbit-5528', 'jbswy3dpehpk3pxp', 'abandon']) {
      expect(text.some((t) => t.includes(secret))).toBe(false);
    }
  });

  it('matches nothing for a blank query', () => {
    expect(ids(index, '   ')).toEqual([]);
  });

  it('is empty once cleared, as on lock', () => {
    const cleared = new SearchIndex();
    cleared.build(tree);
    expect(cleared.size).toBe(3);
    cleared.clear();
    expect(cleared.size).toBe(0);
    expect(cleared.text()).toEqual([]);
    expect(ids(cleared, 'credit')).toEqual([]);
  });

  it('normalizes NFKD, without marks, lowercase', () => {
    expect(normalizeForSearch('Ｃafé ÅNGSTRÖM')).toBe('cafe angstrom');
  });
});
