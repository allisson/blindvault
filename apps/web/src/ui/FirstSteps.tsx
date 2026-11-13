import { type VaultSession } from '@blindvault/vault';
import { useId } from 'react';

import { type Navigation, type SettingsFocus } from '../app/nav';
import { useMessages } from '../i18n/context';
import { Button } from './components';
import { Icon } from './icons';

/**
 * The empty vault's first steps (D250), in place of "No items yet.": the vault made, then a first
 * item, an import and a pairing, each opening where it is done. A read-only vault leaves out the
 * steps that write.
 */
export function FirstSteps({
  session,
  nav,
}: {
  readonly session: VaultSession;
  readonly nav: Navigation;
}) {
  const m = useMessages();
  const id = useId();
  const settings = (focus: SettingsFocus) => () => {
    nav.openSettings(focus);
  };
  const steps = [
    ...(session.writable
      ? [
          {
            key: 'item',
            text: m.vault.stepItem,
            action: m.vault.stepItemAction,
            go: () => {
              nav.select({ name: 'new' });
            },
          },
          {
            key: 'import',
            text: m.vault.stepImport,
            action: m.vault.stepImportAction,
            go: settings('import'),
          },
        ]
      : []),
    { key: 'pair', text: m.ready.pair, action: m.ready.pairAction, go: settings('pair') },
  ];
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3" data-testid="first-steps">
      <h3 id={id} className="font-semibold">
        {m.vault.firstSteps}
      </h3>
      <p className="text-sm text-muted">{m.vault.firstStepsIntro}</p>
      <ol className="flex flex-col gap-3">
        <li className="flex items-start gap-3 text-sm" data-done="true">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink">
            <Icon name="check" label={m.ready.done} className="size-3.5!" />
          </span>
          <span className="leading-6">{m.vault.stepCreated}</span>
        </li>
        {steps.map((step, i) => (
          <li key={step.key} className="flex items-start gap-3 text-sm">
            <span
              aria-hidden="true"
              className="flex size-6 shrink-0 items-center justify-center rounded-full border border-line text-xs font-semibold"
            >
              {i + 2}
            </span>
            <div className="flex flex-col items-start gap-1">
              <span className="leading-6">{step.text}</span>
              <Button variant="secondary" onClick={step.go}>
                {step.action}
              </Button>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
