import { type ReactNode, useId, useState } from 'react';

import { clipboard } from '../app/clipboard';
import { useMessages } from '../i18n/context';
import { format } from '../i18n/messages';
import { Button, CopyCheck, INPUT, Message, useCheck } from './components';
import { Icon } from './icons';
import { useToast } from './Toast';

// Secrets are masked by default in every layout; revealing takes an explicit action, and the
// mask never shows the value's length (overview §13.1, §13.2). A screen reader hears "hidden", not
// the dots.
function Mask() {
  const m = useMessages();
  return (
    <>
      <span aria-hidden="true">••••••••</span>
      <span className="sr-only">{m.items.masked}</span>
    </>
  );
}

function Toggle({ shown, onToggle }: { readonly shown: boolean; readonly onToggle: () => void }) {
  const m = useMessages();
  return (
    <Button variant="quiet" aria-pressed={shown} onClick={onToggle}>
      <Icon name={shown ? 'eye-off' : 'eye'} className="me-2" />
      {shown ? m.items.hide : m.items.show}
    </Button>
  );
}

/**
 * Copies on explicit action, then tries to clear the clipboard after `clearSeconds` (D54, D127);
 * a toast says so, and that clearing is not guaranteed (D250).
 */
export function useCopy(clearSeconds: number | undefined) {
  const m = useMessages();
  const toast = useToast();
  const [checked, check] = useCheck();
  const copy = (text: string) => {
    if (clearSeconds === undefined) return;
    clipboard.copy(text, clearSeconds).then(
      () => {
        toast(format(m.items.copied, { seconds: String(clearSeconds) }));
        check();
      },
      () => {
        toast(m.items.copyFailed, false);
      },
    );
  };
  return { copy, checked };
}

/** `label` shown; the field's `name` completes the accessible name. `checked` shows the check. */
export function CopyButton({
  label,
  name,
  checked,
  onCopy,
}: {
  readonly label: string;
  readonly name: string;
  readonly checked: boolean;
  readonly onCopy: () => void;
}) {
  return (
    <Button variant="quiet" aria-label={`${label}: ${name}`} onClick={onCopy}>
      {checked ? <CopyCheck shown /> : <Icon name="copy" className="me-2" />}
      {label}
    </Button>
  );
}

/** Shown seed-phrase words in a numbered grid (D247); the copy keeps the stored text. */
function Words({ value }: { readonly value: string }) {
  return (
    <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {value
        .trim()
        .split(/\s+/)
        .map((word, i) => (
          // Words repeat; their place is their identity.
          <li key={i} className="rounded-control bg-subtle px-2 py-1">
            <span className="me-2 text-xs text-muted">{i + 1}</span>
            {word}{' '}
          </li>
        ))}
    </ol>
  );
}

/**
 * A stored secret, masked until shown; copied without being shown when `clearSeconds` is set. A
 * shown seed phrase (`words`) is a numbered grid.
 */
export function SecretView({
  value,
  label,
  clearSeconds,
  words = false,
}: {
  readonly value: string;
  readonly label: string;
  readonly clearSeconds?: number | undefined;
  readonly words?: boolean;
}) {
  const m = useMessages();
  const [shown, setShown] = useState(false);
  const { copy, checked } = useCopy(clearSeconds);
  return (
    <div className="flex flex-col gap-1">
      {/* Shown words take the whole row, whole words each, with the buttons below (D247). */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <div
          data-testid={`secret-${label}`}
          className={`min-w-0 flex-1 font-mono text-value whitespace-pre-wrap ${shown && words ? 'basis-full' : 'break-all'}`}
        >
          {!shown ? <Mask /> : words ? <Words value={value} /> : value}
        </div>
        <Toggle
          shown={shown}
          onToggle={() => {
            setShown(!shown);
          }}
        />
        {clearSeconds !== undefined ? (
          <CopyButton
            label={m.items.copy}
            name={label}
            checked={checked}
            onCopy={() => {
              copy(value);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * A secret being edited. Masked, it is a password input, which cannot hold line breaks: a
 * multi-line value is shown as the mask until revealed, so masking never changes it.
 */
export function SecretInput({
  label,
  value,
  onChange,
  error,
  hint,
  shown: shownOutside,
  onShownChange,
  action,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly error?: string | undefined;
  readonly hint?: string | undefined;
  readonly shown?: boolean;
  readonly onShownChange?: (shown: boolean) => void;
  /** A button after Show, as the generator's (D254). */
  readonly action?: ReactNode;
}) {
  const m = useMessages();
  const id = useId();
  const [shownInside, setShownInside] = useState(false);
  const shown = shownOutside ?? shownInside;
  const setShown = onShownChange ?? setShownInside;
  const multiLine = /[\n\r]/.test(value);
  const common = {
    id,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error || hint ? `${id}-message` : undefined,
    autoComplete: 'off',
    spellCheck: false,
    'data-testid': `input-${label}`,
  } as const;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <div className="flex items-start gap-2">
        {shown ? (
          <textarea
            {...common}
            rows={multiLine ? 4 : 1}
            className={`${INPUT} min-w-0 flex-1 py-2 font-mono`}
            value={value}
            onChange={(e) => {
              onChange(e.target.value);
            }}
          />
        ) : multiLine ? (
          <span className={`${INPUT} flex min-w-0 flex-1 items-center font-mono`}>
            <Mask />
          </span>
        ) : (
          <input
            {...common}
            type="password"
            className={`${INPUT} min-w-0 flex-1 font-mono`}
            value={value}
            onChange={(e) => {
              onChange(e.target.value);
            }}
          />
        )}
        <Toggle
          shown={shown}
          onToggle={() => {
            setShown(!shown);
          }}
        />
        {action}
      </div>
      <Message
        id={`${id}-message`}
        error={error}
        hint={hint ?? (multiLine && !shown ? m.items.multiLine : undefined)}
      />
    </div>
  );
}
