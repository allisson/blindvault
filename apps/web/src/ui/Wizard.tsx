import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { useMessages } from '../i18n/context';
import { format } from '../i18n/messages';
import { Button, Message, WizardPlace } from './components';
import { useLayout } from './hooks';
import { Icon } from './icons';

/** A step of a wizard: its name, and what to do meanwhile on the other device, if any (D253). */
export interface WizardStep {
  readonly name: string;
  readonly other?: string;
}

/** What a step's main action needs from its wizard: Cancel beside it, and its bar on a phone. */
interface Actions {
  readonly cancel: ReactNode;
  readonly bar: string;
  readonly claim: () => () => void;
}

const ActionsContext = createContext<Actions | undefined>(undefined);

/**
 * One step at a time (D253) on a screen of its own (D254): "Step N of M · name" with a bar and the
 * next step's name, the step's content, what to do on the other device, and Cancel while there is
 * something to cancel. There is no Back: a failure says why and starts again from step 1.
 */
export function Wizard({
  steps,
  step,
  title,
  screen = true,
  onCancel,
  cancelTestId,
  children,
}: {
  readonly steps: readonly WizardStep[];
  /** 1-based. */
  readonly step: number;
  /** The flow's name, when nothing above names it. */
  readonly title?: string | undefined;
  /** On a screen of its own in Settings (D254); a live sync's Done step is not (D255). */
  readonly screen?: boolean;
  readonly onCancel?: (() => void) | undefined;
  readonly cancelTestId?: string;
  readonly children: ReactNode;
}) {
  const m = useMessages();
  const place = useContext(WizardPlace);
  const mobile = useLayout() === 'mobile';
  const [claimed, setClaimed] = useState(0);
  const claim = useCallback(() => {
    setClaimed((n) => n + 1);
    return () => {
      setClaimed((n) => n - 1);
    };
  }, []);
  const root = useRef<HTMLDivElement>(null);
  const target = useRef<HTMLElement | null>(null);
  const setTarget = (element: HTMLElement | null) => {
    target.current = element;
  };
  // The screen replaces what was clicked: the cursor moves into it, unless a field took it.
  useEffect(() => {
    if (!root.current?.contains(document.activeElement)) target.current?.focus();
  }, []);
  const current = steps[step - 1];
  const next = steps[step];
  const cancel = onCancel ? (
    <Button variant="quiet" onClick={onCancel} data-testid={cancelTestId}>
      {m.wizard.cancel}
    </Button>
  ) : null;
  // Cancel moves to the header on a phone and on the start screens, and beside the step's main
  // action elsewhere (D254).
  const header = place.header;
  const actions: Actions = {
    cancel: header ? null : cancel,
    bar: mobile ? 'sticky bottom-0 z-10 border-t border-line bg-raised py-3' : '',
    claim,
  };
  return (
    <ActionsContext.Provider value={actions}>
      <div
        ref={root}
        className="flex w-full max-w-[35rem] flex-col gap-3"
        data-testid="wizard"
        data-wizard={screen || undefined}
        data-step={step}
      >
        {title ? (
          <h2 ref={setTarget} tabIndex={-1} className="font-semibold">
            {title}
          </h2>
        ) : null}
        <div className="flex flex-col gap-1">
          <p
            ref={title ? undefined : setTarget}
            tabIndex={title ? undefined : -1}
            className="text-sm font-medium text-muted"
            aria-live="polite"
            data-testid="wizard-step"
          >
            {format(m.wizard.step, {
              n: String(step),
              total: String(steps.length),
              name: current?.name ?? '',
            })}
          </p>
          <div className="flex gap-1" aria-hidden="true">
            {steps.map((s, i) => (
              <span
                key={s.name}
                className={`h-1 flex-1 rounded-full ${i < step ? 'bg-accent' : 'bg-line'}`}
              />
            ))}
          </div>
          {next ? (
            <p className="text-sm text-muted" data-testid="wizard-next">
              {format(m.wizard.next, { name: next.name })}
            </p>
          ) : null}
        </div>
        {children}
        {current?.other ? (
          <aside
            className="flex flex-col gap-1 rounded-card border border-line bg-raised p-3 text-sm"
            data-testid="wizard-other"
          >
            <span className="font-semibold">{m.wizard.other}</span>
            <span>{current.other}</span>
          </aside>
        ) : null}
        {/* A step with no main action (a wait) keeps Cancel at its foot. */}
        {header === null && claimed === 0 && cancel ? (
          <div className="self-start">{cancel}</div>
        ) : null}
      </div>
      {header && cancel ? createPortal(cancel, header) : null}
    </ActionsContext.Provider>
  );
}

/** A step's main action: fixed at the bottom on a phone, with Cancel beside it elsewhere (D254). */
export function WizardActions({ children }: { readonly children: ReactNode }) {
  const actions = useContext(ActionsContext);
  const claim = actions?.claim;
  useLayoutEffect(() => claim?.(), [claim]);
  return (
    <div className={`flex flex-wrap items-center gap-2 ${actions?.bar ?? ''}`}>
      {children}
      {actions?.cancel}
    </div>
  );
}

/** The step shown: `step`, or while it is `undefined` (a failure), the last one shown. */
export function useStep(step: number | undefined): number {
  const [last, setLast] = useState(step ?? 1);
  if (step !== undefined && step !== last) setLast(step);
  return step ?? last;
}

/** Options most never need, closed at first: the same network only, the STUN list (D253). */
export function AdvancedOptions({
  open = false,
  children,
}: {
  /** Open at first, when one of the options needs the user. */
  readonly open?: boolean;
  readonly children: ReactNode;
}) {
  const m = useMessages();
  return (
    <details className="text-sm" open={open || undefined} data-testid="advanced-options">
      <summary className="cursor-pointer">{m.wizard.advanced}</summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}

/**
 * A file step's drop area over the same file input (D254): a file chosen or dropped is held, and
 * the step's Continue reads it.
 */
export function FileDrop({
  label,
  accept,
  file,
  disabled = false,
  error,
  testId,
  onFile,
}: {
  readonly label: string;
  readonly accept: string;
  readonly file: File | undefined;
  readonly disabled?: boolean;
  readonly error?: string | undefined;
  readonly testId: string;
  readonly onFile: (file: File) => void;
}) {
  const m = useMessages();
  const id = useId();
  const [over, setOver] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <span id={`${id}-label`} className="text-sm font-medium">
        {label}
      </span>
      <label
        className={`flex cursor-pointer flex-col items-center gap-1 rounded-card border border-dashed border-control p-6 text-center text-sm has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-focus ${over ? 'bg-subtle' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => {
          setOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const dropped = e.dataTransfer.files[0];
          if (dropped && !disabled) onFile(dropped);
        }}
      >
        <Icon name="upload" className="text-muted" />
        <span className="font-medium break-all">{file ? file.name : m.wizard.chooseFile}</span>
        <span className="text-muted">
          {format(m.wizard.drop, { types: accept.split(',').join(', ') })}
        </span>
        <input
          type="file"
          accept={accept}
          disabled={disabled}
          className="sr-only"
          aria-labelledby={`${id}-label`}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-message` : undefined}
          data-testid={testId}
          onChange={(e) => {
            const chosen = e.target.files?.[0];
            e.target.value = '';
            if (chosen) onFile(chosen);
          }}
        />
      </label>
      <Message id={`${id}-message`} error={error} />
    </div>
  );
}
