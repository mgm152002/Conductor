import { useEffect } from 'react';
import type { Appearance } from '@shared/ipc-contract';
import { BUILT_IN_THEMES, GRAPHITE_DARK_THEME_COLORS, GRAPHITE_LIGHT_THEME_COLORS, getThemeColorsForAppearance, type ThemeColorRole } from '@shared/theme-palettes';
import { useThemeStore, type ThemeId } from '../stores/theme-store';

// Keeps the renderer appearance in lockstep with macOS. On mount it asks the
// main process for the current appearance (`theme.get`) and subscribes to the
// `theme.changed` event channel; the main process emits that event from
// `nativeTheme`'s `updated` signal, so a system dark/light switch reaches the
// store — and the applied `dark` class — within 1 second, no restart needed
// (Requirement 22.2). The `<html>` class toggle drives Tailwind's dark variant.

function isAppearance(value: unknown): value is Appearance {
  return value === 'dark' || value === 'light';
}

/** camelCase role → the --app-theme-* variable the stylesheet maps from. */
const roleVariable = (role: ThemeColorRole): string => {
  const special: Partial<Record<ThemeColorRole, string>> = { terminalSelection: '--app-theme-terminal-selection-background' };
  return special[role] ?? `--app-theme-${role.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
};

/** Paint a theme's colours for the shown appearance onto <html>. */
export function applyTheme(themeId: ThemeId, appearance: Appearance): void {
  const root = document.documentElement;
  root.classList.toggle('dark', appearance === 'dark');
  // Hint built-in form controls and scrollbars at the OS level too.
  root.style.colorScheme = appearance;
  const palette = BUILT_IN_THEMES.find((theme) => theme.id === themeId);
  const colors = palette !== undefined
    ? getThemeColorsForAppearance(palette, appearance) ?? palette.colors
    : appearance === 'dark' ? GRAPHITE_DARK_THEME_COLORS : GRAPHITE_LIGHT_THEME_COLORS;
  for (const [role, value] of Object.entries(colors) as Array<[ThemeColorRole, string]>) root.style.setProperty(roleVariable(role), value);
  root.dataset.themeId = themeId;
}

export function useSystemAppearance(): Appearance {
  const appearance = useThemeStore((state) => state.appearance);
  const themeId = useThemeStore((state) => state.themeId);
  const setAppearance = useThemeStore((state) => state.setAppearance);

  useEffect(() => {
    let active = true;

    void window.conductor.theme
      .get()
      .then((value) => {
        if (active && isAppearance(value)) {
          setAppearance(value);
        }
      })
      .catch(() => {
        // Keep the current default if the bridge is unavailable.
      });

    const unsubscribe = window.conductor.on('theme.changed', (payload) => {
      if (isAppearance(payload)) {
        setAppearance(payload);
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [setAppearance]);

  // Apply whenever the shown appearance or the theme changes.
  useEffect(() => {
    applyTheme(themeId, appearance);
  }, [themeId, appearance]);

  const reduceEffects = useThemeStore((state) => state.reduceEffects);
  useEffect(() => {
    document.documentElement.classList.toggle('reduce-effects', reduceEffects);
  }, [reduceEffects]);

  return appearance;
}
