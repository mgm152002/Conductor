import { create } from 'zustand';
import type { Appearance } from '@shared/ipc-contract';

// Renderer-side mirror of the macOS appearance. The main process (`nativeTheme`)
// is the single authority: it answers `theme.get` on boot and pushes every
// change over the `theme.changed` event channel. This store holds the resolved
// appearance so the whole UI can react from one place; `useSystemAppearance`
// keeps it in sync with the bridge and applies the `dark` class to <html>.

/** Accent colour themes (Settings > Appearance). `punch` is the default. */
export type AccentId = 'punch' | 'cobalt' | 'plum' | 'pine' | 'marigold';

export const ACCENTS: Array<{ id: AccentId; label: string; swatch: string }> = [
  { id: 'punch', label: 'Punch red', swatch: '#b23f16' },
  { id: 'cobalt', label: 'Cobalt', swatch: '#2f4fc4' },
  { id: 'plum', label: 'Plum', swatch: '#7431c8' },
  { id: 'pine', label: 'Pine', swatch: '#1e7046' },
  { id: 'marigold', label: 'Marigold', swatch: '#9c6a0a' },
];

const ACCENT_KEY = 'conductor.accent';

function loadAccent(): AccentId {
  try {
    const raw = window.localStorage.getItem(ACCENT_KEY);
    return ACCENTS.some((accent) => accent.id === raw) ? (raw as AccentId) : 'punch';
  } catch {
    return 'punch';
  }
}

interface ThemeState {
  appearance: Appearance;
  accent: AccentId;
  setAppearance: (appearance: Appearance) => void;
  setAccent: (accent: AccentId) => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  // Default to dark to match the window's initial background and avoid a flash
  // before the first `theme.get` resolves.
  appearance: 'dark',
  accent: loadAccent(),
  setAppearance: (appearance): void => {
    set({ appearance });
  },
  setAccent: (accent): void => {
    try {
      window.localStorage.setItem(ACCENT_KEY, accent);
    } catch {
      // Storage can be unavailable; the accent still applies for the session.
    }
    set({ accent });
  },
}));
