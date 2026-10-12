import { useSyncExternalStore } from 'react';

import { DESKTOP_MIN_WIDTH, type Layout, TABLET_MIN_WIDTH } from '../app/layout';

const QUERIES = [
  `(min-width: ${String(TABLET_MIN_WIDTH)}px)`,
  `(min-width: ${String(DESKTOP_MIN_WIDTH)}px)`,
];

function subscribe(onChange: () => void): () => void {
  const lists = QUERIES.map((q) => window.matchMedia(q));
  for (const l of lists) l.addEventListener('change', onChange);
  return () => {
    for (const l of lists) l.removeEventListener('change', onChange);
  };
}

/** The layout for the current viewport width; switching never touches vault state (D15). */
export function useLayout(): Layout {
  return useSyncExternalStore(subscribe, () => {
    const [tablet, desktop] = QUERIES.map((q) => window.matchMedia(q).matches);
    return desktop ? 'desktop' : tablet ? 'tablet' : 'mobile';
  });
}
