import { create } from 'zustand';
import type { Appearance } from '@shared/ipc-contract';
import { BUILT_IN_THEMES, LEGACY_THEME_IDS } from '@shared/theme-palettes';

// Appearance and theme (Settings > Appearance): a colour scheme (follow macOS,
// or force light or dark) and a theme (the default Graphite pair, or one of
// the built-in palettes). The main process reports the macOS appearance over
// `theme.get` / `theme.changed`; `appearance` is the one actually shown.

export type ColorScheme = 'system' | 'light' | 'dark';
/** "graphite" is the default pair; the rest are the built-in palettes. */
export type ThemeId = 'graphite' | (typeof BUILT_IN_THEMES)[number]['id'];

export const THEMES: Array<{ id: ThemeId; label: string }> = [
  { id: 'graphite', label: 'Graphite' },
  ...BUILT_IN_THEMES.map((theme) => ({ id: theme.id as ThemeId, label: theme.label })),
];

const SCHEME_KEY = 'conductor.colorScheme';
const THEME_KEY = 'conductor.theme';

function load<T extends string>(key: string, valid: readonly T[], fallback: T): T {
  try {
    const stored = window.localStorage.getItem(key);
    const raw = stored !== null ? LEGACY_THEME_IDS[stored] ?? stored : null;
    return valid.includes(raw as T) ? (raw as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* the choice still applies for this session */ }
}

const resolve = (scheme: ColorScheme, system: Appearance): Appearance => (scheme === 'system' ? system : scheme);

interface ThemeState {
  /** What macOS is set to. */
  system: Appearance;
  scheme: ColorScheme;
  themeId: ThemeId;
  /** What is shown: the scheme, or macOS's when following it. */
  appearance: Appearance;
  setAppearance: (system: Appearance) => void;
  setScheme: (scheme: ColorScheme) => void;
  setTheme: (themeId: ThemeId) => void;
}

const initialScheme = load<ColorScheme>(SCHEME_KEY, ['system', 'light', 'dark'], 'system');

export const useThemeStore = create<ThemeState>((set, get) => ({
  // Dark until macOS answers, matching the window's first paint.
  system: 'dark',
  scheme: initialScheme,
  themeId: load<ThemeId>(THEME_KEY, THEMES.map((theme) => theme.id), 'graphite'),
  appearance: resolve(initialScheme, 'dark'),
  setAppearance: (system): void => { set({ system, appearance: resolve(get().scheme, system) }); },
  setScheme: (scheme): void => { save(SCHEME_KEY, scheme); set({ scheme, appearance: resolve(scheme, get().system) }); },
  setTheme: (themeId): void => { save(THEME_KEY, themeId); set({ themeId }); },
}));
