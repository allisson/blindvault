// What an import parser reads from a source file, before the mapping of overview §15 (D124) turns
// it into items: the source's own keys and values, with no BlindVault rule applied yet.

export interface SourceField {
  /** The source's name for the value, kept as the field's label when no role takes it. */
  readonly key: string;
  readonly value: string;
  /** A role of the item's template the parser knows the value fills (`username`, `password`…). */
  readonly role?: string;
}

export interface SourceItem {
  readonly title: string;
  /** The factory template the source category matches; absent, the item has none (D124). */
  readonly template?: string;
  /** The source's category name, for an item with no matching template (D124). */
  readonly category?: string;
  /** Values with empty strings left out. */
  readonly fields: readonly SourceField[];
  readonly notes?: string;
  /** The source folder or group path, outermost first (D125). */
  readonly folder?: readonly string[];
  readonly tags?: readonly string[];
  /** Names of the source attachments, which the import drops (D124). */
  readonly attachments?: readonly string[];
}

export interface SourceParse {
  readonly items: readonly SourceItem[];
  /** Source entries left out, each counted once (overview §15, the preview). */
  readonly skipped: number;
}

/** The field, or nothing for an empty value. */
export function field(key: string, value: string | undefined, role?: string): SourceField[] {
  if (value === undefined || value === '') return [];
  return [role === undefined ? { key, value } : { key, value, role }];
}

/** The optional keys of a source item, left out when empty. */
export function optional(
  notes: string | undefined,
  folder?: readonly string[],
): Pick<SourceItem, 'notes' | 'folder'> {
  return {
    ...(notes ? { notes } : {}),
    ...(folder && folder.length > 0 ? { folder } : {}),
  };
}
