import {
  FIELD_TYPES,
  type FieldType,
  TEMPLATES,
  type VaultSession,
  roleOf,
  template,
} from '@blindvault/vault';
import { useEffect, useRef, useState } from 'react';

import { folderRows } from '../app/folders';
import { hex } from '../app/ids';

import {
  type Draft,
  type DraftErrors,
  type DraftField,
  addField,
  draftChanged,
  draftOf,
  inputOf,
  newDraft,
} from '../app/item-draft';
import { type Navigation } from '../app/nav';
import { saveShortcut } from '../app/shortcuts';
import { useLanguage, useMessages } from '../i18n/context';
import { type Messages, roleName } from '../i18n/messages';
import { Button, ConfirmDialog, Field, INPUT, Modal, Notice, TextArea } from './components';
import { writeError } from './errors';
import { Generator } from './Generator';
import { Icon } from './icons';
import { SecretInput } from './Secret';
import { rated, useMeter } from './Strength';
import { useToast } from './Toast';

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
  // Informs only: a weak password is saved like any other (D249).
  const { meter, hint } = useMeter(field.value, rated(field));

  let input;
  if (field.type === 'totp') {
    // Masked like a secret: an otpauth:// URI holds the TOTP secret (D127).
    input = (
      <SecretInput
        label={name}
        value={field.value}
        onChange={set}
        error={error}
        hint={field.totp ? m.items.totpKeep : m.items.totpHint}
        shown={shown}
        onShownChange={setShown}
      />
    );
  } else if (field.type === 'secret' || field.type === 'seed-phrase') {
    input = (
      <SecretInput
        label={name}
        value={field.value}
        onChange={set}
        error={error}
        hint={hint}
        shown={shown}
        onShownChange={setShown}
        action={
          field.type === 'secret' ? (
            <Button
              variant="quiet"
              aria-label={m.generator.generate}
              title={m.generator.title}
              onClick={() => {
                setGenerating(true);
              }}
            >
              <Icon name="dices" />
            </Button>
          ) : null
        }
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
      {meter}
      {generating ? (
        // A dialog, or a bottom sheet on a phone (D254).
        <Modal
          aria-label={m.generator.title}
          onCancel={() => {
            setGenerating(false);
          }}
        >
          <Generator
            onUse={(value) => {
              set(value);
              setGenerating(false);
            }}
            onCancel={() => {
              setGenerating(false);
            }}
          />
        </Modal>
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
      <h1 className="text-title">{m.items.chooseTemplate}</h1>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {TEMPLATES.map((t) => (
          <li key={t.id}>
            <Button
              variant="quiet"
              className="w-full border border-line text-left"
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
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | undefined>(() => {
    const item = id ? session.item(id)?.item : undefined;
    return item ? draftOf(item) : undefined;
  });
  // The draft as opened, or as the template made it: leaving with anything else asks first (D234).
  const [initial, setInitial] = useState(draft);
  const [errors, setErrors] = useState<DraftErrors>();
  const [failure, setFailure] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState<FieldType>('text');
  const [leaving, setLeaving] = useState<() => void>();
  const form = useRef<HTMLFormElement>(null);
  const changed = useRef(false);
  changed.current = draft !== undefined && initial !== undefined && draftChanged(initial, draft);
  // Set in the submit itself: a navigation in the same moment as Save is not held (D210).
  const submitted = useRef(false);
  useEffect(
    () =>
      nav.guard((proceed) => {
        if (submitted.current || !changed.current) return false;
        setLeaving(() => proceed);
        return true;
      }),
    [nav],
  );
  // A refused save puts the cursor in the first field it marks (D234).
  useEffect(() => {
    if (errors) form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [errors]);

  if (!draft) {
    if (id) return null;
    // A new item starts in the folder shown as the list, if any.
    const list = nav.list();
    return (
      <TemplatePicker
        onPick={(picked) => {
          const next = list.name === 'folder' ? { ...picked, folderId: list.id } : picked;
          setDraft(next);
          setInitial(next);
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
      ref={form}
      noValidate
      className="flex w-full max-w-2xl flex-col gap-4 p-4"
      onKeyDown={(e) => {
        // Ctrl/⌘ + Enter saves from any field, the notes included; not from a dialog (D251).
        const inDialog = e.target instanceof Element && e.target.closest('dialog') !== null;
        if (!saveShortcut(e) || leaving || saving || inDialog) return;
        e.preventDefault();
        form.current?.requestSubmit();
      }}
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
        submitted.current = true;
        const from = nav.current();
        const write = id
          ? session.updateItem(id, result.input).then(() => id)
          : session.createItem(result.input);
        write.then(
          (saved) => {
            onChange();
            toast(m.items.saved);
            // An edit goes back to its item; a new item replaces the editor. Unless the user went
            // elsewhere meanwhile (D210).
            nav.follow(from, () => {
              if (id) nav.back();
              else nav.replace({ name: 'item', id: saved });
            });
          },
          (error: unknown) => {
            submitted.current = false;
            setSaving(false);
            setFailure(writeError(error, m));
          },
        );
      }}
    >
      <h1 className="text-title">{m.templates[draft.templateId as keyof Messages['templates']]}</h1>
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
        autoFocus
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
              const type = FIELD_TYPES.find((t) => t === e.target.value);
              if (type) setAdding(type);
            }}
            data-testid="add-field-type"
          >
            {FIELD_TYPES.map((t) => (
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
        <p role="alert" className="text-sm text-danger">
          {failure}
        </p>
      ) : null}
      {/* Fixed at the bottom of the pane, so Save never scrolls away (D254). */}
      <div className="sticky bottom-0 z-10 -mx-4 -mb-4 flex justify-end gap-2 border-t border-line bg-surface px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] max-sm:*:flex-1">
        <Button
          variant="secondary"
          onClick={() => {
            nav.back();
          }}
        >
          {m.items.cancel}
        </Button>
        <Button
          type="submit"
          disabled={saving}
          title={`${m.items.save} (Ctrl/⌘ Enter)`}
          aria-keyshortcuts="Control+Enter Meta+Enter"
        >
          {saving ? m.items.saving : m.items.save}
        </Button>
      </div>
      {leaving ? (
        <ConfirmDialog
          data-testid="discard-confirm"
          confirm={m.items.discard}
          cancel={m.items.keepEditing}
          onConfirm={() => {
            setLeaving(undefined);
            leaving();
          }}
          onCancel={() => {
            setLeaving(undefined);
          }}
        >
          <Notice>{m.items.discardWarning}</Notice>
        </ConfirmDialog>
      ) : null}
    </form>
  );
}
