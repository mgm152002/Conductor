import { useEffect } from 'react';
import type { Appearance } from '@shared/ipc-contract';
import { useThemeStore } from '../stores';

// Keeps the renderer appearance in lockstep with macOS. On mount it asks the
// main process for the current appearance (`theme.get`) and subscribes to the
// `theme.changed` event channel; the main process emits that event from
// `nativeTheme`'s `updated` signal, so a system dark/light switch reaches the
// store — and the applied `dark` class — within 1 second, no restart needed
// (Requirement 22.2). The `<html>` class toggle drives Tailwind's dark variant.

function isAppearance(value: unknown): value is Appearance {
  return value === 'dark' || value === 'light';
}

function applyAppearance(appearance: Appearance): void {
  const root = document.documentElement;
  root.classList.toggle('dark', appearance === 'dark');
  // Hint built-in form controls and scrollbars at the OS level too.
  root.style.colorScheme = appearance;
}

export function useSystemAppearance(): Appearance {
  const appearance = useThemeStore((state) => state.appearance);
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

  // Apply whenever the resolved appearance changes.
  useEffect(() => {
    applyAppearance(appearance);
  }, [appearance]);

  return appearance;
}
