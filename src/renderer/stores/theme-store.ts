import { create } from 'zustand';
import type { Appearance } from '@shared/ipc-contract';

// Renderer-side mirror of the macOS appearance. The main process (`nativeTheme`)
// is the single authority: it answers `theme.get` on boot and pushes every
// change over the `theme.changed` event channel. This store holds the resolved
// appearance so the whole UI can react from one place; `useSystemAppearance`
// keeps it in sync with the bridge and applies the `dark` class to <html>.

interface ThemeState {
  appearance: Appearance;
  setAppearance: (appearance: Appearance) => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  // Default to dark to match the window's initial background and avoid a flash
  // before the first `theme.get` resolves.
  appearance: 'dark',
  setAppearance: (appearance): void => {
    set({ appearance });
  },
}));
