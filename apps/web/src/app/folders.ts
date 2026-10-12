// Folder helpers for the UI over the tree the session derives (overview §6, D14): the session
// still refuses a move into a folder's own subtree or into the trash (D171).

import {
  type BlockedRecord,
  ContentInvalidError,
  FOLDER_NAME_MAX,
  type FolderTree,
  type FolderView,
  RecordBlockedError,
  SubtreeBlockedError,
  VaultLockedError,
  codePointLength,
} from '@blindvault/vault';

import { type Messages } from '../i18n/messages';
import { hex } from './ids';

export type FolderNameResult =
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly error: 'required' | 'too-long' | 'single-line' };

/** A typed folder name as stored: trimmed, single-line, 1 to 256 code points. */
export function folderNameOf(text: string): FolderNameResult {
  const name = text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
  if (name === '') return { ok: false, error: 'required' };
  if (/[\n\r]/.test(name)) return { ok: false, error: 'single-line' };
  if (codePointLength(name) > FOLDER_NAME_MAX) return { ok: false, error: 'too-long' };
  return { ok: true, name };
}

export interface FolderRow {
  readonly folder: FolderView;
  readonly depth: number;
}

/** Every folder of the tree, depth first in display order, with its depth. */
export function folderRows(tree: FolderTree, depth = 0): FolderRow[] {
  return tree.folders.flatMap((n) =>
    n.folder ? [{ folder: n.folder, depth }, ...folderRows(n, depth + 1)] : [],
  );
}

export function findNode(tree: FolderTree, id: Uint8Array): FolderTree | undefined {
  const key = hex(id);
  const walk = (n: FolderTree): FolderTree | undefined => {
    if (n.folder && hex(n.folder.id) === key) return n;
    for (const child of n.folders) {
      const found = walk(child);
      if (found) return found;
    }
    return undefined;
  };
  return walk(tree);
}

/** Where folder `id` may move: the root (`folder: null`), then every folder outside its subtree. */
export function moveTargets(
  tree: FolderTree,
  id: Uint8Array,
): { readonly folder: FolderView | null; readonly depth: number }[] {
  const moving = findNode(tree, id);
  const inside = new Set(
    moving ? [hex(id), ...folderRows(moving).map((r) => hex(r.folder.id))] : [],
  );
  return [
    { folder: null, depth: 0 },
    ...folderRows(tree).filter((r) => !inside.has(hex(r.folder.id))),
  ];
}

/** Why a folder action was refused; a subtree refusal lists its read-only records (overview §6). */
export type FolderFailure =
  | { readonly kind: 'message'; readonly text: string }
  | { readonly kind: 'blocked'; readonly records: readonly BlockedRecord[] };

export function folderFailure(error: unknown, m: Messages): FolderFailure | undefined {
  if (error instanceof VaultLockedError) return undefined;
  if (error instanceof SubtreeBlockedError) return { kind: 'blocked', records: error.records };
  if (error instanceof RecordBlockedError && error.reason === 'cycle') {
    return { kind: 'message', text: m.folders.cycle };
  }
  if (error instanceof ContentInvalidError) return { kind: 'message', text: m.folders.nameTooLong };
  return { kind: 'message', text: m.folders.failed };
}
