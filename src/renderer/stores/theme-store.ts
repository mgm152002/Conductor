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

/**
 * Visual effects (Settings > Appearance > Performance). Translucent blurred
 * surfaces and looping animations are repainted by the GPU every frame the
 * content behind them moves; on older or low-power Macs that is what makes
 * scrolling and streaming feel heavy. "auto" turns them off on such machines.
 */
export type EffectsMode = 'auto' | 'full' | 'reduced';

/** A machine that struggles with live blur: few cores or little memory. */
export function isLowPowerMachine(nav: { hardwareConcurrency?: number; deviceMemory?: number } | undefined = typeof navigator === 'undefined' ? undefined : navigator as Navigator & { deviceMemory?: number }): boolean {
  if (nav === undefined) return false;
  const cores = nav.hardwareConcurrency ?? 8;
  const memory = nav.deviceMemory ?? 8;
  return cores <= 4 || memory <= 4;
}

export const resolveEffects = (mode: EffectsMode, lowPower: boolean): boolean => mode === 'reduced' || (mode === 'auto' && lowPower);

const SCHEME_KEY = 'conductor.colorScheme';
const EFFECTS_KEY = 'conductor.effects';
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
  effects: EffectsMode;
  /** Whether effects are reduced right now (the mode, resolved for this machine). */
  reduceEffects: boolean;
  setEffects: (effects: EffectsMode) => void;
}

const initialScheme = load<ColorScheme>(SCHEME_KEY, ['system', 'light', 'dark'], 'system');
const initialEffects = load<EffectsMode>(EFFECTS_KEY, ['auto', 'full', 'reduced'], 'auto');

export const useThemeStore = create<ThemeState>((set, get) => ({
  // Dark until macOS answers, matching the window's first paint.
  system: 'dark',
  scheme: initialScheme,
  themeId: load<ThemeId>(THEME_KEY, THEMES.map((theme) => theme.id), 'graphite'),
  appearance: resolve(initialScheme, 'dark'),
  setAppearance: (system): void => { set({ system, appearance: resolve(get().scheme, system) }); },
  setScheme: (scheme): void => { save(SCHEME_KEY, scheme); set({ scheme, appearance: resolve(scheme, get().system) }); },
  setTheme: (themeId): void => { save(THEME_KEY, themeId); set({ themeId }); },
  effects: initialEffects,
  reduceEffects: resolveEffects(initialEffects, isLowPowerMachine()),
  setEffects: (effects): void => { save(EFFECTS_KEY, effects); set({ effects, reduceEffects: resolveEffects(effects, isLowPowerMachine()) }); },
}));
