import AxeBuilder from '@axe-core/playwright';
import { type Page, expect } from '@playwright/test';

export const WIDTHS = [
  ['mobile', 375],
  ['tablet', 800],
  ['desktop', 1280],
] as const;
export const THEMES = ['light', 'dark'] as const;

/** WCAG 2.2 A and AA, the target of §13.7 (D231). */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** Fails on any axe violation on the page as it stands, listed by rule and element (D238). */
export async function audit(page: Page, screen: string): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const found = violations.flatMap((v) =>
    v.nodes.map(
      (n) => `${v.id} (${v.impact ?? 'n/a'}): ${n.target.join(' ')}: ${n.failureSummary ?? ''}`,
    ),
  );
  expect(found, `axe on ${screen}`).toEqual([]);
}
