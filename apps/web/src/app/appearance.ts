// Theme and accent (overview §13.7, D231): non-sensitive UI preferences, the one kind `localStorage`
// may hold (§7), for the installation and never synchronized. They are applied before unlock and
// before the first render; an unknown or missing value falls back to its default.

export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

/** The closed list of accents; index.css holds their values and the contrast test checks them. */
export const ACCENTS = ['blue', 'indigo', 'violet', 'teal', 'green', 'rose'] as const;
export type Accent = (typeof ACCENTS)[number];

export interface Appearance {
  readonly theme: Theme;
  readonly accent: Accent;
}

export const DEFAULT_APPEARANCE: Appearance = { theme: 'system', accent: 'blue' };

/** `theme-color` follows the theme only: the surface color of each (index.css). */
export const THEME_COLORS = { light: '#fafafa', dark: '#09090b' } as const;

const STORAGE_KEY = 'blindvault.appearance';
const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Stored preferences, each unknown or missing one replaced by its default. */
export function readAppearance(raw: string | null): Appearance {
  let parsed: unknown;
  try {
    parsed = raw === null ? null : JSON.parse(raw);
  } catch {
    return DEFAULT_APPEARANCE;
  }
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_APPEARANCE;
  const p = parsed as Record<string, unknown>;
  return {
    theme: THEMES.find((t) => t === p.theme) ?? DEFAULT_APPEARANCE.theme,
    accent: ACCENTS.find((a) => a === p.accent) ?? DEFAULT_APPEARANCE.accent,
  };
}

export function loadAppearance(): Appearance {
  try {
    return readAppearance(localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function saveAppearance(appearance: Appearance): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance));
  } catch {
    // storage unavailable: the choice lasts for this app window
  }
}

/** The theme shown: System follows the system's dark mode. */
export function resolveTheme(theme: Theme, systemDark: boolean): 'light' | 'dark' {
  if (theme === 'system') return systemDark ? 'dark' : 'light';
  return theme;
}

/** The parts of the page the appearance touches, so a test can pass its own. */
export interface AppearanceTarget {
  readonly root: { setAttribute(name: string, value: string): void };
  readonly themeColor: { setAttribute(name: string, value: string): void } | null;
  readonly systemDark: { readonly matches: boolean };
}

export function applyAppearance(appearance: Appearance, target: AppearanceTarget): void {
  const theme = resolveTheme(appearance.theme, target.systemDark.matches);
  target.root.setAttribute('data-theme', theme);
  target.root.setAttribute('data-accent', appearance.accent);
  target.themeColor?.setAttribute('content', THEME_COLORS[theme]);
}

let current: Appearance = DEFAULT_APPEARANCE;

function pageTarget(query: MediaQueryList): AppearanceTarget {
  return {
    root: document.documentElement,
    themeColor: document.querySelector('meta[name="theme-color"]'),
    systemDark: query,
  };
}

/**
 * Applies the stored appearance and follows the system theme while System is chosen. Called once,
 * before the first render.
 */
export function startAppearance(): void {
  const query = matchMedia(DARK_QUERY);
  current = loadAppearance();
  applyAppearance(current, pageTarget(query));
  query.addEventListener('change', () => {
    applyAppearance(current, pageTarget(query));
  });
}

export function currentAppearance(): Appearance {
  return current;
}

/** A choice made in Settings › Appearance: shown at once and kept for the installation. */
export function setAppearance(appearance: Appearance): void {
  current = appearance;
  saveAppearance(appearance);
  applyAppearance(appearance, pageTarget(matchMedia(DARK_QUERY)));
}
