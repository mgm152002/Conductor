import { BrowserWindow } from 'electron';
import { marketplaceEntryFromCard, type MarketplaceCard, type McpMarketplaceEntry } from '@shared/mcp-marketplace';
import type { MarketplaceCatalog } from './mcp-service';

// Browses mcpservers.org in a hidden Chromium window. The site bot-guards
// plain HTTP clients (403), but a real Chromium loads it normally. Pages
// are loaded sandboxed with no Node access, navigation is pinned to
// mcpservers.org, and only card/detail data is extracted — nothing from
// the page is ever executed in the app or persisted except the derived
// install endpoint the user then approves.

const BASE = 'https://mcpservers.org';

const EXTRACT_CARDS = `(() => {
  const seen = new Map();
  for (const a of document.querySelectorAll('a[href^="/servers/"]')) {
    const slug = a.getAttribute('href').slice('/servers/'.length);
    if (!slug || seen.has(slug)) continue;
    const name = a.querySelector('[data-slot="card-title"]')?.textContent?.trim()
      ?? a.innerText.split('\\n').map(s => s.trim()).filter(Boolean)[0] ?? slug;
    const official = [...a.querySelectorAll('*')].some(el => el.children.length === 0 && el.textContent.trim() === 'official');
    const img = a.querySelector('img');
    seen.set(slug, {
      slug, name, official,
      ...(img?.getAttribute('src') ? { logoUrl: new URL(img.getAttribute('src'), location.origin).href } : {}),
      lines: a.innerText.split('\\n').map(s => s.trim()).filter(Boolean),
    });
  }
  return [...seen.values()];
})()`;

const EXTRACT_CODE = `(() => [...document.querySelectorAll('pre')].map(p => p.textContent ?? '').filter(t => t.trim() !== ''))()`;

export class ElectronMarketplaceCatalog implements MarketplaceCatalog {
  private async withPage<T>(url: string, extract: string, parse: (raw: unknown) => T): Promise<T> {
    const win = new BrowserWindow({
      show: false, width: 1280, height: 900,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    try {
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', (event, target) => {
        if (!target.startsWith(BASE)) event.preventDefault();
      });
      await win.loadURL(url);
      // Server-rendered cards are in the first paint; give hydration a beat.
      await new Promise((resolve) => { setTimeout(resolve, 1200); });
      const raw: unknown = await win.webContents.executeJavaScript(extract);
      return parse(raw);
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  }

  /** Inline a card logo as a data URL (the renderer cannot load external images). */
  private async logoDataUrl(logoUrl: string | undefined): Promise<string | undefined> {
    if (logoUrl === undefined) return undefined;
    try {
      const response = await fetch(logoUrl, { signal: AbortSignal.timeout(8_000) });
      if (!response.ok) return undefined;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0 || buffer.length > 200_000) return undefined;
      const type = response.headers.get('content-type')?.split(';')[0] ?? 'image/png';
      return `data:${type};base64,${buffer.toString('base64')}`;
    } catch { return undefined; }
  }

  async search(query: string): Promise<McpMarketplaceEntry[]> {
    const url = query.trim() === '' ? `${BASE}/all` : `${BASE}/search?query=${encodeURIComponent(query.trim())}`;
    const cards = await this.withPage(url, EXTRACT_CARDS, (raw) =>
      (Array.isArray(raw) ? raw : []) as (MarketplaceCard & { logoUrl?: string })[]);
    const entries = cards.map((card) => marketplaceEntryFromCard(card));
    await Promise.all(cards.map(async (card, i) => {
      const dataUrl = await this.logoDataUrl(card.logoUrl);
      if (dataUrl !== undefined) entries[i]!.logoDataUrl = dataUrl;
    }));
    return entries;
  }

  async detail(entry: McpMarketplaceEntry): Promise<{ codeBlocks: string[] }> {
    const codeBlocks = await this.withPage(`${BASE}/servers/${entry.id}`, EXTRACT_CODE, (raw) =>
      (Array.isArray(raw) ? raw : []).filter((b): b is string => typeof b === 'string'));
    return { codeBlocks };
  }
}
