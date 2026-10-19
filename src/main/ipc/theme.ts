import { nativeTheme, type WebContents } from 'electron';
import { ThemeGetRequest, type Appearance } from '@shared/ipc-contract';
import type { IpcRouter } from './router';

// macOS appearance relay. `nativeTheme` is the single authority for whether the
// system is in dark or light mode; the renderer never consults a media query.
// The main process answers `theme.get` on demand and pushes every subsequent
// change over the `theme.changed` event channel, so the renderer can match the
// system appearance within 1 second without a restart (Requirement 22.2).

/** Resolve the current macOS appearance from `nativeTheme`. */
export function currentAppearance(): Appearance {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

export interface ThemeRelayDeps {
  router: IpcRouter;
  /** The window's web contents to push `theme.changed` events to. */
  getWebContents: () => WebContents | null;
}

/**
 * Register the `theme.get` handler and begin relaying `nativeTheme` updates.
 * Returns a disposer that detaches the `nativeTheme` listener (used on teardown
 * and in tests). Following the system appearance is the default: leaving
 * `nativeTheme.themeSource` at `'system'` makes `shouldUseDarkColors` track the
 * OS so a change between dark and light fires `updated` here.
 */
export function registerThemeRelay(deps: ThemeRelayDeps): () => void {
  const { router, getWebContents } = deps;

  nativeTheme.themeSource = 'system';

  router.handle('theme.get', ThemeGetRequest, (): Appearance =>
    currentAppearance(),
  );

  const onUpdated = (): void => {
    const target = getWebContents();
    if (target === null || target.isDestroyed()) {
      return;
    }
    router.emit(target, 'theme.changed', currentAppearance());
  };

  nativeTheme.on('updated', onUpdated);

  return () => {
    nativeTheme.removeListener('updated', onUpdated);
  };
}
