import { useId, useState } from 'react';

import { useMessages } from '../i18n/context';
import { Button, INPUT } from './components';

// Secrets are masked by default in every layout; revealing takes an explicit action, and the
// mask never shows the value's length (overview §13.1, §13.2).
const MASK = '••••••••';

function Toggle({ shown, onToggle }: { readonly shown: boolean; readonly onToggle: () => void }) {
  const m = useMessages();
  return (
    <Button variant="quiet" aria-pressed={shown} onClick={onToggle}>
      {shown ? m.items.hide : m.items.show}
    </Button>
  );
}

/** A stored secret, masked until shown. */
export function SecretView({ value, label }: { readonly value: string; readonly label: string }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <span
        data-testid={`secret-${label}`}
        className="min-w-0 flex-1 font-mono text-sm break-all whitespace-pre-wrap"
      >
        {shown ? value : MASK}
      </span>
      <Toggle
        shown={shown}
        onToggle={() => {
          setShown(!shown);
        }}
      />
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
          <span className={`${INPUT} flex min-w-0 flex-1 items-center font-mono`}>{MASK}</span>
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
      {error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : hint || (multiLine && !shown) ? (
        <p className="text-sm text-zinc-500">{hint ?? m.items.multiLine}</p>
      ) : null}
    </div>
  );
}
