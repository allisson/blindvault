// Layout by available viewport width, never by user agent (overview §13.1, D15).

export type Layout = 'mobile' | 'tablet' | 'desktop';

export const TABLET_MIN_WIDTH = 640;
export const DESKTOP_MIN_WIDTH = 1024;

export function layoutFor(width: number): Layout {
  if (width >= DESKTOP_MIN_WIDTH) return 'desktop';
  if (width >= TABLET_MIN_WIDTH) return 'tablet';
  return 'mobile';
}
