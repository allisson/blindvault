import {
  ContentInvalidError,
  FOLDER_NAME_MAX,
  type FolderTree,
  type FolderView,
  RecordBlockedError,
  SubtreeBlockedError,
  VaultLockedError,
} from '@blindvault/vault';
import { describe, expect, it } from 'vitest';

import { MESSAGES } from '../i18n/messages';
import { findNode, folderFailure, folderNameOf, folderRows, moveTargets } from './folders';

const HLC = { physicalMs: 1, counter: 0, deviceId: new Uint8Array(16) };

function folder(n: number, name: string): FolderView {
  return {
    id: new Uint8Array(16).fill(n),
    hlc: HLC,
    name,
    inTrash: false,
    unknownKeys: [],
  };
}

function node(f: FolderView | null, folders: FolderTree[] = []): FolderTree {
  return { folder: f, folders, items: [] };
}

// root ─ A ─ A1 ─ A1a
//      │    └ A2
//      └ B
const a1a = node(folder(4, 'A1a'));
const a1 = node(folder(2, 'A1'), [a1a]);
const a2 = node(folder(3, 'A2'));
const a = node(folder(1, 'A'), [a1, a2]);
const b = node(folder(5, 'B'));
const tree = node(null, [a, b]);

describe('folder names (record-content.md §6)', () => {
  it('trims and accepts 1 to 256 code points', () => {
    expect(folderNameOf('  Work  ')).toEqual({ ok: true, name: 'Work' });
    expect(folderNameOf('\u{1F600}'.repeat(FOLDER_NAME_MAX)).ok).toBe(true);
  });

  it.each([
    ['empty', ' \t ', 'required'],
    ['too long', 'x'.repeat(FOLDER_NAME_MAX + 1), 'too-long'],
    ['multi-line', 'a\nb', 'single-line'],
  ])('refuses a name that is %s', (_name, text, error) => {
    expect(folderNameOf(text)).toEqual({ ok: false, error });
  });
});

describe('the displayed folder tree', () => {
  it('lists every folder once, depth first, with its depth', () => {
    expect(folderRows(tree).map((r) => [r.folder.name, r.depth])).toEqual([
      ['A', 0],
      ['A1', 1],
      ['A1a', 2],
      ['A2', 1],
      ['B', 0],
    ]);
  });

  it('finds a folder node by ID, and nothing for an unknown one', () => {
    expect(findNode(tree, new Uint8Array(16).fill(2))).toBe(a1);
    expect(findNode(tree, new Uint8Array(16).fill(9))).toBeUndefined();
  });

  it('offers as move targets the root and every folder outside the subtree (D171)', () => {
    const targets = moveTargets(tree, new Uint8Array(16).fill(2));
    expect(targets.map((t) => (t.folder ? t.folder.name : 'root'))).toEqual([
      'root',
      'A',
      'A2',
      'B',
    ]);
  });
});

describe('refused folder actions', () => {
  const m = MESSAGES.en;

  it('lists the read-only records of a refused subtree (overview §6)', () => {
    const records = [
      { recordType: 1, recordId: new Uint8Array(16), reason: 'newer-content' as const },
    ];
    expect(folderFailure(new SubtreeBlockedError(records), m)).toEqual({
      kind: 'blocked',
      records,
    });
  });

  it('names a move into the folder itself, and stays silent on a lock', () => {
    expect(folderFailure(new RecordBlockedError('cycle'), m)).toEqual({
      kind: 'message',
      text: m.folders.cycle,
    });
    expect(folderFailure(new RecordBlockedError('in-trash'), m)).toEqual({
      kind: 'message',
      text: m.folders.failed,
    });
    expect(folderFailure(new ContentInvalidError('name'), m)).toEqual({
      kind: 'message',
      text: m.folders.nameTooLong,
    });
    expect(folderFailure(new VaultLockedError(), m)).toBeUndefined();
  });
});
