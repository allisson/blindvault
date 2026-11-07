// Icons copied from Lucide 1.61.0 (`lucide-static`), ISC; `lock` and `plus` derive from Feather, MIT.
// Both notices are in ./LICENSE. Copied, not depended on (overview §13.7, D231, D233): add an icon
// by copying its paths from the same version.

import type { ReactNode } from 'react';

const PATHS = {
  check: <path d="M20 6 9 17l-5-5" />,
  'loader-circle': <path d="M21 12a9 9 0 1 1-6.219-8.56" />,
  lock: (
    <>
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </>
  ),
  plus: (
    <>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </>
  ),
  settings: (
    <>
      <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

/**
 * An icon in the text's color, inline with the text. Decorative unless `label` is given: an icon
 * alone carries an accessible name, and a security action always keeps its visible text.
 */
export function Icon({
  name,
  label,
  className = '',
}: {
  readonly name: IconName;
  readonly label?: string;
  readonly className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`inline-block size-4 shrink-0 align-[-0.125em] ${className}`}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      {PATHS[name]}
    </svg>
  );
}
