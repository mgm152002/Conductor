import { create } from 'zustand';
import type { Appearance } from '@shared/ipc-contract';

// Renderer-side mirror of the macOS appearance. The main process (`nativeTheme`)
// is the single authority: it answers `theme.get` on boot and pushes every
// change over the `theme.changed` event channel. This store holds the resolved
// appearance so the whole UI can react from one place; `useSystemAppearance`
// keeps it in sync with the bridge and applies the `dark` class to <html>.

/** Accent colour themes (Settings > Appearance). `orchid` is the default. */
export type AccentId = 'orchid' | 'cobalt' | 'pine' | 'marigold' | 'ember';

export const ACCENTS: Array<{ id: AccentId; label: string; swatch: string }> = [
  { id: 'orchid', label: 'Orchid', swatch: '#c9379a' },
  { id: 'cobalt', label: 'Cobalt', swatch: '#4a6fe8' },
  { id: 'pine', label: 'Pine', swatch: '#2a9763' },
  { id: 'marigold', label: 'Marigold', swatch: '#c58c1c' },
  { id: 'ember', label: 'Ember', swatch: '#e0602c' },
];

// Versioned: the Score palette replaced the earlier accent set, so a choice
// stored against the old set is not carried over.
const ACCENT_KEY = 'conductor.accent.v2';

function loadAccent(): AccentId {
  try {
    const raw = window.localStorage.getItem(ACCENT_KEY);
    return ACCENTS.some((accent) => accent.id === raw) ? (raw as AccentId) : 'orchid';
  } catch {
    return 'orchid';
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
