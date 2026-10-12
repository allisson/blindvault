// The item editor's draft and its conversion to the session's `ItemInput`, with the rules of
// `record-content.md` §3–§4 reported per field. The session checks the content again on write.

import {
  type FieldType,
  type Item,
  type ItemInput,
  LABEL_MAX,
  TAGS_MAX,
  TAG_MAX,
  TITLE_MAX,
  type Template,
  codePointLength,
  isValidDate,
  isValidSeedPhrase,
  normalizeSeedPhrase,
  normalizeTags,
  roleOf,
  template,
} from '@blindvault/vault';

type Field = Item['fields'][number];

export interface DraftField {
  /** Stable within the editor, for React and for the errors. */
  readonly key: number;
  readonly type: FieldType;
  readonly role?: string;
  /** The user's label; empty means none. */
  readonly label: string;
  /** Text as typed; a TOTP field keeps its stored value in `totp`, not edited here. */
  readonly value: string;
  readonly totp?: Exclude<Field['value'], string>;
}

export interface Draft {
  readonly templateId: string;
  readonly templateVersion: number;
  readonly title: string;
  readonly fields: readonly DraftField[];
  /** Comma-separated, as typed. */
  readonly tags: string;
  readonly notes: string;
  /** Absent, or `undefined` once cleared: the vault root. */
  readonly folderId?: Uint8Array | undefined;
}

export type FieldError =
  'single-line' | 'date' | 'month' | 'number' | 'seed-phrase' | 'label-required' | 'label-too-long';

export interface DraftErrors {
  readonly title?: 'required' | 'too-long';
  readonly tags?: 'too-many' | 'too-long';
  readonly fields: ReadonlyMap<number, FieldError>;
}

export type DraftResult =
  | { readonly ok: true; readonly input: ItemInput }
  | { readonly ok: false; readonly errors: DraftErrors };

let nextKey = 1;

function key(): number {
  return nextKey++;
}

const EDGES = /^\p{White_Space}+|\p{White_Space}+$/gu;

function trim(text: string): string {
  return text.replace(EDGES, '');
}

/** A new item of template `t`: its roles in order, empty. */
export function newDraft(t: Template): Draft {
  return {
    templateId: t.id,
    templateVersion: t.version,
    title: '',
    fields: t.roles.map((r) => ({ key: key(), type: r.type, role: r.role, label: '', value: '' })),
    tags: '',
    notes: '',
  };
}

/** `item` as a draft; the template roles it does not hold follow its own fields, empty. */
export function draftOf(item: Item): Draft {
  const fields: DraftField[] = item.fields.map((f) => ({
    key: key(),
    type: f.type,
    ...(f.role !== undefined ? { role: f.role } : {}),
    label: f.label ?? '',
    ...(typeof f.value === 'string' ? { value: f.value } : { value: '', totp: f.value }),
  }));
  const held = new Set(item.fields.map((f) => f.role));
  for (const r of template(item.templateId)?.roles ?? []) {
    if (!held.has(r.role)) {
      fields.push({ key: key(), type: r.type, role: r.role, label: '', value: '' });
    }
  }
  return {
    templateId: item.templateId,
    templateVersion: item.templateVersion,
    title: item.title,
    fields,
    tags: item.tags.join(', '),
    notes: item.notes ?? '',
    ...(item.folderId ? { folderId: item.folderId } : {}),
  };
}

/** A field the user adds, of a v1 field type, with no role. */
export function addField(draft: Draft, type: FieldType): Draft {
  return { ...draft, fields: [...draft.fields, { key: key(), type, label: '', value: '' }] };
}

const TRIMMED: ReadonlySet<FieldType> = new Set([
  'text',
  'url',
  'email',
  'phone',
  'date',
  'number',
]);

type Checked = { readonly value: string } | { readonly error: FieldError } | null;

/** The stored value of `f`, `null` when empty (never written), or why it is refused. */
function check(f: DraftField, monthOnly: boolean): Checked {
  if (f.type === 'seed-phrase') {
    const v = normalizeSeedPhrase(f.value);
    if (v === '') return null;
    return isValidSeedPhrase(v) ? { value: v } : { error: 'seed-phrase' };
  }
  const v = TRIMMED.has(f.type) ? trim(f.value) : f.value;
  if (v === '') return null;
  switch (f.type) {
    case 'long-text':
    case 'secret':
      return { value: v };
    case 'date':
      if (monthOnly) {
        return /^[0-9]{4}-[0-9]{2}$/.test(v) && isValidDate(v, true)
          ? { value: v }
          : { error: 'month' };
      }
      return isValidDate(v, false) ? { value: v } : { error: 'date' };
    case 'number':
      return /^-?[0-9]+(\.[0-9]+)?$/.test(v) ? { value: v } : { error: 'number' };
    default:
      return /[\n\r]/.test(v) ? { error: 'single-line' } : { value: v };
  }
}

/** The content the session writes, or the rules the draft breaks. */
export function inputOf(draft: Draft): DraftResult {
  const t = template(draft.templateId);
  const fieldErrors = new Map<number, FieldError>();
  const fields: Field[] = [];
  for (const f of draft.fields) {
    const label = trim(f.label);
    if (f.totp) {
      fields.push({ type: f.type, value: f.totp, ...named(f.role, label) });
      continue;
    }
    const monthOnly = (f.role && t ? roleOf(t, f.role)?.monthPrecision : undefined) === true;
    const checked = check(f, monthOnly);
    if (checked === null) continue;
    if ('error' in checked) {
      fieldErrors.set(f.key, checked.error);
      continue;
    }
    if (f.role === undefined && label === '') {
      fieldErrors.set(f.key, 'label-required');
      continue;
    }
    if (codePointLength(label) > LABEL_MAX) {
      fieldErrors.set(f.key, 'label-too-long');
      continue;
    }
    fields.push({ type: f.type, value: checked.value, ...named(f.role, label) });
  }

  const title = trim(draft.title);
  const titleError =
    title === '' ? 'required' : codePointLength(title) > TITLE_MAX ? 'too-long' : undefined;
  const tags = normalizeTags(draft.tags.split(','));
  const tagsError =
    tags.length > TAGS_MAX
      ? 'too-many'
      : tags.some((tag) => codePointLength(tag) > TAG_MAX)
        ? 'too-long'
        : undefined;

  if (titleError || tagsError || fieldErrors.size > 0) {
    return {
      ok: false,
      errors: {
        ...(titleError ? { title: titleError } : {}),
        ...(tagsError ? { tags: tagsError } : {}),
        fields: fieldErrors,
      },
    };
  }
  const notes = trim(draft.notes) === '' ? undefined : draft.notes;
  return {
    ok: true,
    input: {
      templateId: draft.templateId,
      templateVersion: draft.templateVersion,
      title,
      fields,
      tags,
      ...(notes !== undefined ? { notes } : {}),
      ...(draft.folderId ? { folderId: draft.folderId } : {}),
    },
  };
}

function named(role: string | undefined, label: string) {
  return { ...(role !== undefined ? { role } : {}), ...(label !== '' ? { label } : {}) };
}
