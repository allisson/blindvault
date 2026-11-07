import { useId, useState } from 'react';

import { clipboard } from '../app/clipboard';
import { useMessages } from '../i18n/context';
import { format } from '../i18n/messages';
import { Button, CopyCheck, INPUT, Message, useCheck } from './components';

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
      {shown ? m.items.hide : m.items.show}
    </Button>
  );
}

/**
 * Copies on explicit action, then tries to clear the clipboard after `clearSeconds` (D54, D127);
 * `status` says so, and that clearing is not guaranteed.
 */
export function useCopy(clearSeconds: number | undefined) {
  const m = useMessages();
  const [state, setState] = useState<'copied' | 'failed'>();
  const [checked, check] = useCheck();
  const copy = (text: string) => {
    if (clearSeconds === undefined) return;
    clipboard.copy(text, clearSeconds).then(
      () => {
        setState('copied');
        check();
      },
      () => {
        setState('failed');
      },
    );
  };
  const status =
    state && clearSeconds !== undefined ? (
      <p role="status" className="text-xs text-muted">
        {state === 'copied'
          ? format(m.items.copied, { seconds: String(clearSeconds) })
          : m.items.copyFailed}
      </p>
    ) : null;
  return { copy, status, checked };
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
      <CopyCheck shown={checked} />
      {label}
    </Button>
  );
}

/** A stored secret, masked until shown; copied without being shown when `clearSeconds` is set. */
export function SecretView({
  value,
  label,
  clearSeconds,
}: {
  readonly value: string;
  readonly label: string;
  readonly clearSeconds?: number | undefined;
}) {
  const m = useMessages();
  const [shown, setShown] = useState(false);
  const { copy, status, checked } = useCopy(clearSeconds);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span
          data-testid={`secret-${label}`}
          className="min-w-0 flex-1 font-mono text-sm break-all whitespace-pre-wrap"
        >
          {shown ? value : <Mask />}
        </span>
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
      {status}
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
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly error?: string | undefined;
  readonly hint?: string | undefined;
  readonly shown?: boolean;
  readonly onShownChange?: (shown: boolean) => void;
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
      </div>
      <Message
        id={`${id}-message`}
        error={error}
        hint={hint ?? (multiLine && !shown ? m.items.multiLine : undefined)}
      />
    </div>
  );
}
