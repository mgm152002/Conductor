import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';

// A mutable fake of Electron's `nativeTheme`: a tiny event emitter plus the
// `shouldUseDarkColors`/`themeSource` fields the relay reads and sets. Mocking
// the `electron` module lets the relay run under Node with no real app.
const nativeThemeListeners = new Set<() => void>();
const nativeTheme = {
  shouldUseDarkColors: true,
  themeSource: 'system' as 'system' | 'dark' | 'light',
  on(event: string, listener: () => void): void {
    if (event === 'updated') {
      nativeThemeListeners.add(listener);
    }
  },
  removeListener(event: string, listener: () => void): void {
    if (event === 'updated') {
      nativeThemeListeners.delete(listener);
    }
  },
  /** Test helper: flip the system appearance and fire `updated`. */
  emitUpdated(dark: boolean): void {
    nativeTheme.shouldUseDarkColors = dark;
    for (const listener of nativeThemeListeners) {
      listener();
    }
  },
};

vi.mock('electron', () => ({ nativeTheme }));

// Import after the mock is registered so `theme.ts` binds to the fake.
const { registerThemeRelay, currentAppearance } = await import(
  '@main/ipc/theme'
);
const { IpcRouter } = await import('@main/ipc/router');

function makeIpcMain(): IpcMain & { handlers: Map<string, unknown> } {
  const handlers = new Map<string, unknown>();
  const ipcMain = {
    handle: (channel: string, listener: unknown) => {
      handlers.set(channel, listener);
    },
  } as unknown as IpcMain & { handlers: Map<string, unknown> };
  ipcMain.handlers = handlers;
  return ipcMain;
}

function makeWebContents(): {
  contents: Electron.WebContents;
  sent: { channel: string; payload: unknown }[];
} {
  const sent: { channel: string; payload: unknown }[] = [];
  const contents = {
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => {
      sent.push({ channel, payload });
    },
  } as unknown as Electron.WebContents;
  return { contents, sent };
}

describe('theme relay', () => {
  beforeEach(() => {
    nativeThemeListeners.clear();
    nativeTheme.shouldUseDarkColors = true;
    nativeTheme.themeSource = 'system';
  });

  afterEach(() => {
    nativeThemeListeners.clear();
  });

  it('resolves the current appearance from nativeTheme', () => {
    nativeTheme.shouldUseDarkColors = true;
    expect(currentAppearance()).toBe('dark');
    nativeTheme.shouldUseDarkColors = false;
    expect(currentAppearance()).toBe('light');
  });

  it('follows the system by setting themeSource to system', () => {
    const ipcMain = makeIpcMain();
    const router = new IpcRouter({ ipcMain });
    const { contents } = makeWebContents();

    registerThemeRelay({ router, getWebContents: () => contents });

    expect(nativeTheme.themeSource).toBe('system');
  });

  it('registers the theme.get handler returning the appearance', async () => {
    const ipcMain = makeIpcMain();
    const router = new IpcRouter({ ipcMain });
    const { contents } = makeWebContents();
    nativeTheme.shouldUseDarkColors = false;

    registerThemeRelay({ router, getWebContents: () => contents });

    const handler = ipcMain.handlers.get('theme.get') as (
      event: unknown,
      payload: unknown,
    ) => Promise<{ ok: boolean; value?: unknown }>;
    const result = await handler({}, undefined);
    expect(result).toEqual({ ok: true, value: 'light' });
  });

  it('pushes a theme.changed event when the system appearance changes', () => {
    const ipcMain = makeIpcMain();
    const router = new IpcRouter({ ipcMain });
    const { contents, sent } = makeWebContents();

    registerThemeRelay({ router, getWebContents: () => contents });
    nativeTheme.emitUpdated(false);

    expect(sent).toEqual([{ channel: 'theme.changed', payload: 'light' }]);

    nativeTheme.emitUpdated(true);
    expect(sent[1]).toEqual({ channel: 'theme.changed', payload: 'dark' });
  });

  it('does not emit after the relay is disposed', () => {
    const ipcMain = makeIpcMain();
    const router = new IpcRouter({ ipcMain });
    const { contents, sent } = makeWebContents();

    const dispose = registerThemeRelay({
      router,
      getWebContents: () => contents,
    });
    dispose();
    nativeTheme.emitUpdated(false);

    expect(sent).toHaveLength(0);
  });

  it('skips emitting when there is no live web contents', () => {
    const ipcMain = makeIpcMain();
    const router = new IpcRouter({ ipcMain });

    registerThemeRelay({ router, getWebContents: () => null });
    expect(() => {
      nativeTheme.emitUpdated(false);
    }).not.toThrow();
  });
});
