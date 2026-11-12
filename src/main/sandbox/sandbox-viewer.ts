import { BrowserWindow, shell } from 'electron';
import type { SandboxEndpoint } from './sandbox-manager';

// A window onto a sandbox's desktop (the AIO image's noVNC page), so the user
// can watch an agent use its browser and take over if needed. It is a plain,
// isolated web page: no preload, no Node, and it may not navigate away from
// the sandbox's own origin. One window per sandbox; reopening focuses it.

const viewers = new Map<string, BrowserWindow>();

export function openSandboxViewer(endpoint: SandboxEndpoint, title = 'Sandbox'): void {
  const existing = viewers.get(endpoint.baseUrl);
  if (existing !== undefined && !existing.isDestroyed()) { existing.show(); existing.focus(); return; }
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    title: `${title} — live sandbox`,
    backgroundColor: '#111111',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
  });
  const origin = new URL(endpoint.baseUrl).origin;
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && new URL(url).origin !== origin) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    try { if (new URL(url).origin !== origin) event.preventDefault(); } catch { event.preventDefault(); }
  });
  // The API key authorises both the page and noVNC's WebSocket (/websockify),
  // which noVNC opens separately: `path` carries the key onto that URL too,
  // or the sandbox answers 401 and noVNC shows "Failed to connect to server".
  // It is only ever sent to the loopback sandbox.
  const url = new URL('/vnc/index.html', endpoint.baseUrl);
  url.searchParams.set('autoconnect', 'true');
  url.searchParams.set('resize', 'scale');
  url.searchParams.set('reconnect', 'true');
  url.searchParams.set('api_key', endpoint.apiKey);
  url.searchParams.set('path', `websockify?api_key=${encodeURIComponent(endpoint.apiKey)}`);
  void window.loadURL(url.toString());
  viewers.set(endpoint.baseUrl, window);
  window.on('closed', () => { viewers.delete(endpoint.baseUrl); });
}
