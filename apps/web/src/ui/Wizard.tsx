import { type ReactNode, useState } from 'react';

import { useMessages } from '../i18n/context';
import { format } from '../i18n/messages';
import { Button } from './components';

/** A step of a wizard: its name, and what to do meanwhile on the other device, if any (D253). */
export interface WizardStep {
  readonly name: string;
  readonly other?: string;
}

/**
 * One step at a time (D253): "Step N of M · name" with a bar, the step's content, what to do on the
 * other device, and Cancel while there is something to cancel. There is no Back: a failure says why
 * and starts again from step 1.
 */
export function Wizard({
  steps,
  step,
  onCancel,
  cancelTestId,
  children,
}: {
  readonly steps: readonly WizardStep[];
  /** 1-based. */
  readonly step: number;
  readonly onCancel?: (() => void) | undefined;
  readonly cancelTestId?: string;
  readonly children: ReactNode;
}) {
  const m = useMessages();
  const current = steps[step - 1];
  return (
    <div className="flex flex-col gap-3" data-testid="wizard" data-step={step}>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-muted" aria-live="polite" data-testid="wizard-step">
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
      {onCancel ? (
        <Button
          variant="quiet"
          className="self-start"
          onClick={onCancel}
          data-testid={cancelTestId}
        >
          {m.wizard.cancel}
        </Button>
      ) : null}
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
