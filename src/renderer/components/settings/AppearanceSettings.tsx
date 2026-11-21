import type { CSSProperties } from 'react';
import { MoonIcon, SunIcon } from 'lucide-react';
import { BUILT_IN_THEMES, GRAPHITE_DARK_THEME_COLORS, GRAPHITE_LIGHT_THEME_COLORS, getThemeColorsForAppearance, type ThemeAppearance, type ThemeColors } from '@shared/theme-palettes';
import { cn } from '../../lib/cn';
import { THEMES, useThemeStore, type ColorScheme, type ThemeId } from '../../stores/theme-store';
import { SettingsSection } from './SettingsLayout';

// Settings > Appearance (design adapted under MIT; see third-party-licenses):
// a colour scheme picked from three
// small window previews, then a theme picked from its light and dark orbs.

function colorsOf(themeId: ThemeId, mode: ThemeAppearance): ThemeColors {
  const palette = BUILT_IN_THEMES.find((theme) => theme.id === themeId);
  if (palette === undefined) return mode === 'dark' ? GRAPHITE_DARK_THEME_COLORS : GRAPHITE_LIGHT_THEME_COLORS;
  return getThemeColorsForAppearance(palette, mode) ?? palette.colors;
}

// Each orb: a tinted base with the accent and action colours as soft glows.
const SPECS = {
  light: { base: '#ffffff', accent: '72% 22%', action: '18% 82%', middle: 0.72 },
  dark: { base: '#09090b', accent: '28% 78%', action: '82% 18%', middle: 0.62 },
} as const;

function orbStyle(colors: ThemeColors, mode: ThemeAppearance): CSSProperties {
  const spec = SPECS[mode];
  return {
    backgroundColor: `color-mix(in oklab, ${colors.canvas} 80%, ${spec.base})`,
    backgroundImage: [
      `radial-gradient(circle at ${spec.accent} in oklab, ${colors.accent} 0%, color-mix(in oklab, ${colors.accent} ${spec.middle * 100}%, transparent) 28%, transparent 58%)`,
      `radial-gradient(circle at ${spec.action} in oklab, color-mix(in oklab, ${colors.messageAction} 45%, transparent) 0%, transparent 55%)`,
    ].join(', '),
    filter: 'blur(3px)',
    transform: 'scale(1.1)',
  };
}

function ThemeOrb({ colors, mode, picked, label, onPick }: { colors: ThemeColors; mode: ThemeAppearance; picked: boolean; label: string; onPick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={picked}
      aria-label={`Use ${label} ${mode} mode`}
      title={`Use ${label} for ${mode} mode`}
      onClick={(event) => { event.stopPropagation(); onPick(); }}
      className={cn('relative flex size-[68px] shrink-0 transform-gpu cursor-pointer items-center justify-center rounded-full p-1.5 outline-none transition-transform hover:scale-105 focus-visible:outline-2 focus-visible:-outline-offset-5 focus-visible:outline-foreground/60', picked && 'hover:scale-100')}
    >
      <span aria-hidden className="relative block size-14 shrink-0 overflow-hidden rounded-full border-2 border-background"
        style={{ boxShadow: mode === 'dark' ? 'inset 0 0 0 1px rgb(255 255 255 / 0.14), 0 1px 2px rgb(0 0 0 / 0.18)' : 'inset 0 0 0 1px rgb(0 0 0 / 0.10), 0 1px 2px rgb(0 0 0 / 0.08)' }}>
        <span className="absolute inset-0 rounded-full" style={orbStyle(colors, mode)} />
      </span>
      {picked ? (
        <>
          <span aria-hidden className="pointer-events-none absolute inset-0 rounded-full" style={{ boxShadow: 'inset 0 0 0 2px var(--ring)' }} />
          <span aria-hidden className="pointer-events-none absolute right-0.5 bottom-0.5 flex size-5 items-center justify-center rounded-full border border-border/70 bg-background text-foreground shadow-sm">
            {mode === 'light' ? <SunIcon className="size-3" /> : <MoonIcon className="size-3" />}
          </span>
        </>
      ) : null}
    </button>
  );
}

/** A tiny window: sidebar, two text lines, a floating panel and the composer with its send dot. */
function WindowSketch({ colors }: { colors: ThemeColors }): React.JSX.Element {
  return (
    <span className="flex h-full w-full overflow-hidden" style={{ background: colors.canvas }}>
      <span className="flex w-[22%] flex-col gap-1.5 p-2" style={{ background: colors.sidebar }}>
        <span className="h-2.5 rounded-full" style={{ background: colors.surfaceOverlay, boxShadow: `inset 0 0 0 1px ${colors.border}` }} />
        <span className="h-2 rounded-full opacity-60" style={{ background: colors.sidebarRowSelected }} />
        <span className="h-2 rounded-full opacity-40" style={{ background: colors.sidebarRowSelected }} />
      </span>
      <span className="relative flex flex-1 flex-col gap-1.5 p-3 pt-5">
        <span className="h-1.5 w-1/2 rounded-full" style={{ background: colors.border }} />
        <span className="h-1.5 w-1/3 rounded-full" style={{ background: colors.border }} />
        <span className="absolute top-3 right-3 flex w-[22%] flex-col gap-1.5 rounded-md p-1.5" style={{ background: colors.surfaceOverlay, boxShadow: `0 0 0 1px ${colors.border}` }}>
          {[colors.messageAction, colors.warning, colors.textMuted].map((dot, index) => (
            <span key={index} className="flex items-center gap-1"><span className="size-1 rounded-full" style={{ background: dot }} /><span className="h-1 flex-1 rounded-full" style={{ background: colors.border }} /></span>
          ))}
        </span>
        <span className="absolute right-3 bottom-3 left-3 flex h-5 items-center justify-between rounded-md px-1.5" style={{ background: colors.surfaceOverlay, boxShadow: `0 0 0 1px ${colors.border}` }}>
          <span className="h-1 w-1/3 rounded-full" style={{ background: colors.border }} />
          <span className="size-2.5 rounded-full" style={{ background: colors.messageAction }} />
        </span>
      </span>
    </span>
  );
}

function SchemeCard({ scheme, themeId, active, onPick }: { scheme: ColorScheme; themeId: ThemeId; active: boolean; onPick: () => void }): React.JSX.Element {
  const label = scheme === 'system' ? 'System' : scheme === 'light' ? 'Light' : 'Dark';
  return (
    <button type="button" role="radio" aria-checked={active} onClick={onPick}
      className={cn('flex cursor-pointer flex-col gap-2 rounded-xl border bg-card/40 p-2 pb-2.5 text-sm font-medium text-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active ? 'border-transparent ring-2 ring-ring' : 'border-border/60 hover:bg-accent/50')}>
      <span className="relative block aspect-[16/9] w-full overflow-hidden rounded-lg">
        {scheme === 'system' ? (
          <>
            <span className="absolute inset-0"><WindowSketch colors={colorsOf(themeId, 'light')} /></span>
            <span className="absolute inset-0 [clip-path:inset(0_0_0_50%)]"><WindowSketch colors={colorsOf(themeId, 'dark')} /></span>
          </>
        ) : <WindowSketch colors={colorsOf(themeId, scheme)} />}
      </span>
      <span>{label}</span>
    </button>
  );
}

export function AppearanceSettings(): React.JSX.Element {
  const scheme = useThemeStore((s) => s.scheme);
  const themeId = useThemeStore((s) => s.themeId);
  const appearance = useThemeStore((s) => s.appearance);
  const setScheme = useThemeStore((s) => s.setScheme);
  const setTheme = useThemeStore((s) => s.setTheme);
  return (
    <>
      <SettingsSection title="Color scheme">
        <div role="radiogroup" aria-label="Color scheme" className="grid grid-cols-3 gap-3">
          {(['system', 'light', 'dark'] as const).map((option) => (
            <SchemeCard key={option} scheme={option} themeId={themeId} active={scheme === option} onPick={() => { setScheme(option); }} />
          ))}
        </div>
      </SettingsSection>
      <SettingsSection title="Themes">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {THEMES.map((theme) => {
            const active = themeId === theme.id;
            return (
              <div key={theme.id} role="button" tabIndex={0} aria-pressed={active}
                onClick={() => { setTheme(theme.id); }}
                onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setTheme(theme.id); } }}
                className={cn('flex cursor-pointer flex-col rounded-xl border bg-card/40 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring', active ? 'border-border' : 'border-border/60 hover:bg-accent/40')}>
                <div className="flex min-h-16 items-center justify-center gap-2.5 px-3 pt-3">
                  {(['light', 'dark'] as const).map((mode) => (
                    <ThemeOrb key={mode} mode={mode} label={theme.label} colors={colorsOf(theme.id, mode)}
                      picked={active && (scheme === 'system' || appearance === mode)}
                      onPick={() => { setTheme(theme.id); if (scheme !== 'system') setScheme(mode); }} />
                  ))}
                </div>
                <div className="flex items-center px-4 pt-2 pb-3.5"><span className="text-sm font-medium text-foreground">{theme.label}</span></div>
              </div>
            );
          })}
        </div>
      </SettingsSection>
    </>
  );
}
