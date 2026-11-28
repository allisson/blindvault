import { type Field } from '@blindvault/vault';
import { useEffect, useState } from 'react';

import { type Strength, estimator } from '../app/strength';
import { useLanguage } from '../i18n/context';
import { format } from '../i18n/messages';
import { Badge } from './components';

// The strength of an item's password (D249): zxcvbn, as for the local password (D71), but it only
// informs; a weak item password is saved like any other.

export type Level = 'weak' | 'fair' | 'strong';

/** zxcvbn's score as a level: 0 to 2 weak, 3 fair, 4 strong. */
export function level(score: Strength['score']): Level {
  return score === 4 ? 'strong' : score === 3 ? 'fair' : 'weak';
}

/** Whether a field is rated: a template's password, the one secret whose use is known. */
export function rated(field: Pick<Field, 'role' | 'type'>): boolean {
  return field.role === 'password' && field.type === 'secret';
}

/** The strength of `value`, once the dictionaries are loaded; none for an empty value. */
export function useStrength(value: string, enabled = true): Strength | undefined {
  const { language } = useLanguage();
  const [strength, setStrength] = useState<{ readonly of: string; readonly s: Strength }>();
  useEffect(() => {
    let current = true;
    if (!enabled || value === '') return;
    void estimator(language).then((estimate) => {
      if (current) setStrength({ of: value, s: estimate(value) });
    });
    return () => {
      current = false;
    };
  }, [value, enabled, language]);
  // Never the rating of an earlier value.
  return enabled && strength?.of === value ? strength.s : undefined;
}

const BAR = { weak: 'bg-danger', fair: 'bg-warning', strong: 'bg-success' } as const;
const TEXT = { weak: 'text-danger', fair: 'text-warning', strong: 'text-success' } as const;
const WIDTH = ['w-1/4', 'w-1/4', 'w-2/4', 'w-3/4', 'w-full'] as const;

/**
 * The editor's meter: one 4 px bar filled to the score and its level in the level's colour, seen
 * only (D315); its level and advice are the field's hint.
 */
export function useMeter(value: string, enabled: boolean) {
  const m = useLanguage().messages;
  const strength = useStrength(value, enabled);
  if (!strength) return { meter: null, hint: undefined };
  const l = level(strength.score);
  const hint = [
    format(m.items.strength, { level: m.items.strengthLevels[l] }),
    l === 'strong' ? '' : strength.warning || m.items.strengthAdvice,
  ]
    .filter((t) => t !== '')
    .join(' ');
  const meter = (
    <div
      aria-hidden="true"
      className="flex items-center gap-3"
      data-testid="item-strength"
      data-level={l}
    >
      <span className="h-1 flex-1 rounded-full bg-line">
        <span className={`block h-1 rounded-full ${WIDTH[strength.score]} ${BAR[l]}`} />
      </span>
      <span className={`text-xs font-medium ${TEXT[l]}`}>{m.items.strengthLevels[l]}</span>
    </div>
  );
  return { meter, hint };
}

/** The detail's badge, shown only for a weak password. */
export function WeakBadge({ value }: { readonly value: string }) {
  const m = useLanguage().messages;
  const strength = useStrength(value);
  return strength && level(strength.score) === 'weak' ? (
    <Badge tone="warning" data-testid="weak-badge">
      {m.items.strengthLevels.weak}
    </Badge>
  ) : null;
}
