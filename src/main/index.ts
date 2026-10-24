import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isApplicationUrl } from './navigation-policy';
import { app, BrowserWindow } from 'electron';
import { bootstrap, type AppServices } from './bootstrap';
import { registerThemeRelay } from './ipc/theme';

// electron-vite injects these at build time; in dev the renderer is served by
// the dev server, in production it is loaded from the packaged bundle.
const RENDERER_DEV_URL = process.env['ELECTRON_RENDERER_URL'];

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 832,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#0b0b0d',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Hardened boundary — the renderer gets no Node handle and runs
      // sandboxed with a dedicated origin. Loosening any of these is a
      // security regression (see design: Process & module boundaries).
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      nodeIntegration: false,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  const applicationUrl = RENDERER_DEV_URL ?? pathToFileURL(join(__dirname, '../renderer/index.html')).href;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!isApplicationUrl(url, applicationUrl)) event.preventDefault();
  });

  if (RENDERER_DEV_URL !== undefined) {
    void window.loadURL(RENDERER_DEV_URL);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return window;
}

app.whenReady().then(async () => {
  // Compose the main-process services (store, domain, validated IPC router)
  // before opening the window so the renderer's first bridge calls resolve.
  const services: AppServices = await bootstrap();

  let window = createMainWindow();

  // Resolve the live renderer target each time so it survives window recreation
  // on `activate`. Shared by the theme relay and the task-event emitter.
  const getWebContents = (): Electron.WebContents | null => {
    if (window.isDestroyed()) {
      return null;
    }
    return window.webContents;
  };

  // Relay macOS appearance through the IPC event channel.
  registerThemeRelay({ router: services.router, getWebContents });

  // Let the orchestrator stream RUNNING execution events to the renderer.
  services.taskEvents.setWebContentsResolver(getWebContents);
  services.chatEvents.setWebContentsResolver(getWebContents);

  // Let the data-control service surface the external-flow indicator (Req 21.1).
  services.externalFlowEvents.setWebContentsResolver(getWebContents);
  // Live connector state for the Connections screen, then start background
  // indexing (watchers + scheduled sweep, gated on the sync preference).
  services.connectorEvents.setWebContentsResolver(getWebContents);
  services.connectorRuntime.start();
  services.suggestionEvents.setWebContentsResolver(getWebContents);
  services.mcp.startHealthChecks();
  app.on('before-quit', () => {
    void services.chat.stop();
    services.connectorRuntime.stop();
    void services.mcp.stop();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      window = createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // macOS apps conventionally stay alive until the user quits explicitly.
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
