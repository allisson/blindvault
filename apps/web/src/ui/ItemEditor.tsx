import {
  FIELD_TYPES,
  type FieldType,
  TEMPLATES,
  type VaultSession,
  roleOf,
  template,
} from '@blindvault/vault';
import { useState } from 'react';

import { folderRows } from '../app/folders';
import { hex } from '../app/ids';

import {
  type Draft,
  type DraftErrors,
  type DraftField,
  addField,
  draftOf,
  inputOf,
  newDraft,
} from '../app/item-draft';
import { type Navigation } from '../app/nav';
import { useLanguage, useMessages } from '../i18n/context';
import { type Messages, roleName } from '../i18n/messages';
import { Button, Field, INPUT, Notice, TextArea } from './components';
import { writeError } from './errors';
import { Generator } from './Generator';
import { SecretInput } from './Secret';

// TOTP input (otpauth:// parsing, D127) comes with the TOTP field.
const ADDABLE = FIELD_TYPES.filter((t) => t !== 'totp');

const INPUT_TYPES: Partial<Record<FieldType, string>> = {
  url: 'url',
  email: 'email',
  phone: 'tel',
};

function FieldEditor({
  draft,
  field,
  error,
  onChange,
  onRemove,
}: {
  readonly draft: Draft;
  readonly field: DraftField;
  readonly error: string | undefined;
  readonly onChange: (field: DraftField) => void;
  readonly onRemove: () => void;
}) {
  const m = useMessages();
  const [generating, setGenerating] = useState(false);
  const [shown, setShown] = useState(false);
  const custom = field.role === undefined;
  const t = template(draft.templateId);
  const def = field.role !== undefined && t ? roleOf(t, field.role) : undefined;
  const label = field.label.trim();
  const name =
    label !== ''
      ? label
      : ((field.role !== undefined ? roleName(m, draft.templateId, field.role) : undefined) ??
        m.fieldTypes[field.type]);
  const set = (value: string) => {
    onChange({ ...field, value });
  };

  let input;
  if (field.totp) {
    input = (
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">{name}</span>
        <Notice>{m.items.totpLater}</Notice>
      </div>
    );
  } else if (field.type === 'secret' || field.type === 'seed-phrase') {
    input = (
      <SecretInput
        label={name}
        value={field.value}
        onChange={set}
        error={error}
        shown={shown}
        onShownChange={setShown}
      />
    );
  } else if (field.type === 'long-text') {
    input = (
      <TextArea
        label={name}
        value={field.value}
        error={error}
        onChange={(e) => {
          set(e.target.value);
        }}
        data-testid={`input-${name}`}
      />
    );
  } else {
    const month = def?.monthPrecision === true;
    input = (
      <Field
        label={name}
        type={field.type === 'date' && !month ? 'date' : (INPUT_TYPES[field.type] ?? 'text')}
        inputMode={field.type === 'number' ? 'decimal' : undefined}
        placeholder={month ? m.items.monthFormat : undefined}
        value={field.value}
        error={error}
        onChange={(e) => {
          set(e.target.value);
        }}
        data-testid={`input-${name}`}
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {custom ? (
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Field
              label={`${m.items.fieldLabel} (${m.fieldTypes[field.type]})`}
              value={field.label}
              onChange={(e) => {
                onChange({ ...field, label: e.target.value });
              }}
              data-testid="custom-label"
            />
          </div>
          <Button variant="quiet" onClick={onRemove}>
            {m.items.remove}
          </Button>
        </div>
      ) : null}
      {input}
      {field.type === 'secret' && !field.totp ? (
        <div className="flex flex-col gap-2">
          <Button
            variant="quiet"
            className="self-start"
            aria-expanded={generating}
            onClick={() => {
              setGenerating(!generating);
            }}
          >
            {m.generator.generate}
          </Button>
          {generating ? (
            <Generator
              onUse={(value) => {
                set(value);
                setGenerating(false);
              }}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function fieldError(m: Messages, errors: DraftErrors | undefined, key: number) {
  const code = errors?.fields.get(key);
  return code ? m.errors[code] : undefined;
}

function TemplatePicker({ onPick }: { readonly onPick: (draft: Draft) => void }) {
  const m = useMessages();
  return (
    <div className="flex w-full max-w-2xl flex-col gap-4 p-4">
      <h1 className="text-xl font-semibold">{m.items.chooseTemplate}</h1>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {TEMPLATES.map((t) => (
          <li key={t.id}>
            <Button
              variant="quiet"
              className="w-full border border-zinc-200 text-left dark:border-zinc-800"
              onClick={() => {
                onPick(newDraft(t));
              }}
            >
              {m.templates[t.id as keyof Messages['templates']]}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Creates an item (no `id`) or edits one; saving unchanged content writes nothing (D165). */
export function ItemEditor({
  session,
  id,
  nav,
  onChange,
}: {
  readonly session: VaultSession;
  readonly id?: Uint8Array;
  readonly nav: Navigation;
  readonly onChange: () => void;
}) {
  const { messages: m, language } = useLanguage();
  const [draft, setDraft] = useState<Draft | undefined>(() => {
    const item = id ? session.item(id)?.item : undefined;
    return item ? draftOf(item) : undefined;
  });
  const [errors, setErrors] = useState<DraftErrors>();
  const [failure, setFailure] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState<FieldType>('text');

  if (!draft) {
    if (id) return null;
    // A new item starts in the folder shown as the list, if any.
    const list = nav.list();
    return (
      <TemplatePicker
        onPick={(picked) => {
          setDraft(list.name === 'folder' ? { ...picked, folderId: list.id } : picked);
        }}
      />
    );
  }
  const folders = folderRows(session.tree(new Intl.Collator(language).compare));
  const folderKey = draft.folderId ? hex(draft.folderId) : '';
  const update = (next: Draft) => {
    setDraft(next);
    setFailure(undefined);
  };

  return (
    <form
      noValidate
      className="flex w-full max-w-2xl flex-col gap-4 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        const result = inputOf(draft);
        if (!result.ok) {
          setErrors(result.errors);
          setFailure(m.items.invalid);
          return;
        }
        setErrors(undefined);
        setSaving(true);
        const write = id
          ? session.updateItem(id, result.input).then(() => id)
          : session.createItem(result.input);
        write.then(
          (saved) => {
            onChange();
            // An edit goes back to its item; a new item replaces the editor.
            if (id) nav.back();
            else nav.replace({ name: 'item', id: saved });
          },
          (error: unknown) => {
            setSaving(false);
            setFailure(writeError(error, m));
          },
        );
      }}
    >
      <h1 className="text-xl font-semibold">
        {m.templates[draft.templateId as keyof Messages['templates']]}
      </h1>
      <Field
        label={m.items.title}
        value={draft.title}
        error={
          errors?.title === 'required'
            ? m.errors.titleRequired
            : errors?.title === 'too-long'
              ? m.errors.titleTooLong
              : undefined
        }
        onChange={(e) => {
          update({ ...draft, title: e.target.value });
        }}
        data-testid="item-title"
      />
      {draft.fields.map((field) => (
        <FieldEditor
          key={field.key}
          draft={draft}
          field={field}
          error={fieldError(m, errors, field.key)}
          onChange={(next) => {
            update({ ...draft, fields: draft.fields.map((f) => (f.key === next.key ? next : f)) });
          }}
          onRemove={() => {
            update({ ...draft, fields: draft.fields.filter((f) => f.key !== field.key) });
          }}
        />
      ))}
      <div className="flex items-end gap-2">
        <label className="flex flex-1 flex-col gap-1 text-sm font-medium">
          {m.items.addField}
          <select
            className={INPUT}
            value={adding}
            onChange={(e) => {
              const type = ADDABLE.find((t) => t === e.target.value);
              if (type) setAdding(type);
            }}
            data-testid="add-field-type"
          >
            {ADDABLE.map((t) => (
              <option key={t} value={t}>
                {m.fieldTypes[t]}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="quiet"
          onClick={() => {
            update(addField(draft, adding));
          }}
        >
          {m.items.add}
        </Button>
      </div>
      <label className="flex flex-col gap-1 text-sm font-medium">
        {m.folders.folder}
        <select
          className={INPUT}
          value={folderKey}
          onChange={(e) => {
            const picked = folders.find((r) => hex(r.folder.id) === e.target.value);
            update({ ...draft, folderId: picked?.folder.id });
          }}
          data-testid="item-folder"
        >
          <option value="">{m.folders.root}</option>
          {folderKey !== '' && !folders.some((r) => hex(r.folder.id) === folderKey) ? (
            // A folder not shown in the tree: kept unless the user picks another (D14).
            <option value={folderKey}>{m.folders.root}</option>
          ) : null}
          {folders.map((r) => (
            <option key={hex(r.folder.id)} value={hex(r.folder.id)}>
              {`${'\u00a0\u00a0'.repeat(r.depth)}${r.folder.name}`}
            </option>
          ))}
        </select>
      </label>
      <Field
        label={m.items.tags}
        hint={m.items.tagsHint}
        value={draft.tags}
        error={
          errors?.tags === 'too-many'
            ? m.errors.tagsTooMany
            : errors?.tags === 'too-long'
              ? m.errors.tagTooLong
              : undefined
        }
        onChange={(e) => {
          update({ ...draft, tags: e.target.value });
        }}
        data-testid="item-tags"
      />
      <TextArea
        label={m.items.notes}
        value={draft.notes}
        onChange={(e) => {
          update({ ...draft, notes: e.target.value });
        }}
        data-testid="item-notes"
      />
      {failure ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {failure}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={saving}>
          {saving ? m.items.saving : m.items.save}
        </Button>
        <Button
          variant="quiet"
          onClick={() => {
            nav.back();
          }}
        >
          {m.items.cancel}
        </Button>
      </div>
    </form>
  );
}
