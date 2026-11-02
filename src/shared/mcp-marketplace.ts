// The MCP marketplace is mcpservers.org, browsed live from the app —
// nothing is hardcoded. The main process loads the site's search pages in
// a hidden Chromium window (the site bot-guards plain HTTP clients),
// extracts the server cards, and — at install time — loads the server's
// detail page and derives its published install configuration (remote URL
// or stdio command) from the config blocks shown there. Installing
// registers the server untrusted + stopped; approval is what starts it.
//
// `verified` is mcpservers.org's own "official" flag: it is only set for
// servers the site marks official, and only those get the blue check.
// Each entry also carries the server's real logo (fetched by the main
// process and inlined as a data URL, since the renderer cannot load
// external images).

export type McpMarketplaceIcon =
  | 'video' | 'image' | 'github' | 'folder' | 'brain' | 'thinking'
  | 'browser' | 'database' | 'bug' | 'checklist' | 'note' | 'shapes' | 'chart' | 'globe';

export interface McpMarketplaceEntry {
  /** mcpservers.org detail path, e.g. "github/github-mcp-server". */
  id: string;
  name: string;
  publisher: string;
  description: string;
  /** Category as listed on mcpservers.org, e.g. "Version Control". */
  category: string;
  icon: McpMarketplaceIcon;
  /** Avatar background colour (hex), derived from the server name. */
  color: string;
  /** Marked "official" on mcpservers.org. Only these get the blue check. */
  verified: boolean;
  /** GitHub stars label when the site shows one, e.g. "34k". */
  stars?: string;
  /** The mcpservers.org detail page for this server. */
  websiteUrl?: string;
  /** The server's real logo, inlined as a data URL by the main process. */
  logoDataUrl?: string;
  /** Install endpoint — resolved from the detail page at install time. */
  endpoint: string;
  installable: boolean;
  authNote: string;
  tools: string[];
}

/** One server card as extracted from a mcpservers.org listing page. */
export interface MarketplaceCard {
  slug: string;
  name: string;
  official: boolean;
  logoUrl?: string;
  /** The card's visible text lines, in order. */
  lines: string[];
}

const PALETTE = ['#7c3aed', '#0369a1', '#047857', '#b45309', '#be185d', '#0f766e', '#4338ca', '#9d2449', '#334155', '#a16207'];

function colorFor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length]!;
}

function iconFor(text: string): McpMarketplaceIcon {
  const t = text.toLowerCase();
  if (/video|movie|film/.test(t)) return 'video';
  if (/image|photo|picture|diffusion/.test(t)) return 'image';
  if (/github|git|version control|code/.test(t)) return 'github';
  if (/browser|playwright|puppeteer|web|scrap|crawl/.test(t)) return 'browser';
  if (/database|sql|postgres|mysql|mongo|sqlite|data/.test(t)) return 'database';
  if (/notion|linear|slack|calendar|email|productivity|task|issue/.test(t)) return 'checklist';
  if (/memory|knowledge|reasoning|thinking|search|ai/.test(t)) return 'brain';
  if (/file|filesystem|document|drive|storage/.test(t)) return 'folder';
  if (/figma|design|diagram|chart|slide|presentation/.test(t)) return 'shapes';
  if (/sentry|error|monitor|observ|analytics/.test(t)) return 'bug';
  if (/stripe|payment|invoice|finance/.test(t)) return 'chart';
  if (/note|doc/.test(t)) return 'note';
  return 'globe';
}

/**
 * Build an entry from a listing card. Card text is, in order: name,
 * category, optional "official", optional stars, description, and a final
 * identifier line (owner/repo or slug).
 */
export function marketplaceEntryFromCard(card: MarketplaceCard): McpMarketplaceEntry {
  const lines = card.lines.map((l) => l.trim()).filter((l) => l !== '');
  const rest = lines.slice(1);
  const category = rest[0] ?? 'General';
  const afterCategory = rest.slice(1).filter((l) => l !== 'official');
  const stars = afterCategory[0] !== undefined && /^[\d.]+k?$/.test(afterCategory[0]) ? afterCategory[0] : undefined;
  const body = stars !== undefined ? afterCategory.slice(1) : afterCategory;
  const identifier = body.length > 1 ? body[body.length - 1]! : '';
  const description = (body.length > 1 ? body.slice(0, -1) : body).join(' ').slice(0, 300);
  const publisher = identifier.includes('/') ? identifier.split('/')[0]! : card.slug.split('/')[0]!;
  return {
    id: card.slug,
    name: card.name,
    publisher,
    description,
    category,
    icon: iconFor(`${card.name} ${category} ${description}`),
    color: colorFor(card.slug),
    verified: card.official,
    ...(stars !== undefined ? { stars } : {}),
    websiteUrl: `https://mcpservers.org/servers/${card.slug}`,
    endpoint: '',
    installable: true,
    authNote: 'Install reads the server’s published configuration from its mcpservers.org page. Credentials it needs (tokens, env vars) are not configured by the install.',
    tools: [],
  };
}

function quoteArg(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** A credential a server needs: name plus the literal placeholder in the
 *  endpoint (absent = the value is passed as an environment variable). */
export interface McpSecretSlotSpec { name: string; placeholder?: string }

const PLACEHOLDER = /(YOUR_[A-Z0-9_]+|\$\{[A-Za-z_][A-Za-z0-9_]*\}|\{[A-Za-z_][A-Za-z0-9_]*\})/g;

function slotName(placeholder: string): string {
  if (placeholder.startsWith('YOUR_')) {
    const stripped = placeholder.slice(5).replace(/_HERE$/, '').replace(/_KEY$/, '_KEY');
    return stripped === '' ? 'API_KEY' : stripped;
  }
  return placeholder.replace(/^\$\{|\}$|^\{|\}$/g, '');
}

/** Find credential placeholders (YOUR_API_KEY_HERE, ${TOKEN}, {TOKEN}) in an endpoint. */
export function detectSecretSlots(endpoint: string, envNames: readonly string[] = []): McpSecretSlotSpec[] {
  const slots = new Map<string, McpSecretSlotSpec>();
  for (const name of envNames) slots.set(name, { name });
  for (const match of endpoint.matchAll(PLACEHOLDER)) {
    const placeholder = match[0];
    const name = slotName(placeholder);
    slots.set(name, { name, placeholder });
  }
  return [...slots.values()];
}

export interface DerivedInstall { endpoint: string; installable: boolean; note: string; secretSlots: McpSecretSlotSpec[] }

function installFromConfig(config: Record<string, unknown>): DerivedInstall | null {
  const obj = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  const servers = obj(config['mcpServers']) ?? obj(config['servers']) ?? (typeof config['command'] === 'string' || typeof config['url'] === 'string' ? config : null);
  if (servers === null) return null;
  const first = obj(Object.values(servers)[0]);
  if (first === null) return null;
  const env = obj(first['env']);
  const envNames = env !== null ? Object.keys(env) : [];
  const envNote = envNames.length > 0
    ? `You will be asked for ${envNames.join(', ')} — stored in your macOS Keychain, never in the endpoint.`
    : '';
  if (typeof first['url'] === 'string' && /^https:\/\//i.test(first['url'])) {
    return { endpoint: first['url'], installable: true, note: envNote || 'Remote server. Sign-in happens when the agent first connects.', secretSlots: detectSecretSlots(first['url'], envNames) };
  }
  if (typeof first['command'] === 'string') {
    const args = Array.isArray(first['args']) ? first['args'].filter((a): a is string => typeof a === 'string') : [];
    const endpoint = [first['command'], ...args].map(quoteArg).join(' ');
    return { endpoint, installable: true, note: envNote || 'Local server, runs on your Mac when approved.', secretSlots: detectSecretSlots(endpoint, envNames) };
  }
  return null;
}

/**
 * Derive the install endpoint from a detail page's code blocks: JSON MCP
 * configs first, then hosted `add-mcp 'https://…'` commands, then a bare
 * remote URL in a config snippet.
 */
export function deriveInstallFromDetail(codeBlocks: readonly string[]): DerivedInstall {
  for (const block of codeBlocks) {
    const trimmed = block.trim();
    const jsonStarts = [...trimmed.matchAll(/\{/g)].map((m) => m.index ?? 0);
    for (const start of jsonStarts.slice(0, 6)) {
      let depth = 0;
      let end = -1;
      for (let i = start; i < trimmed.length; i += 1) {
        if (trimmed[i] === '{') depth += 1;
        if (trimmed[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
      }
      if (end < 0) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
        if (parsed !== null && typeof parsed === 'object') {
          const install = installFromConfig(parsed as Record<string, unknown>);
          if (install !== null) return install;
        }
      } catch { /* not JSON — try the next candidate */ }
    }
    const hosted = /add-mcp\s+'?(https?:\/\/[^\s'")]+)/.exec(trimmed) ?? /"(?:url|serverUrl)"\s*:\s*"(https:[^"]+)"/.exec(trimmed);
    if (hosted?.[1] !== undefined) {
      return { endpoint: hosted[1], installable: true, note: 'Remote server. Sign-in happens when the agent first connects.', secretSlots: detectSecretSlots(trimmed) };
    }
    // A plain command line, e.g. `npx mcp-remote https://… --header 'Authorization: Bearer YOUR_API_KEY_HERE'`
    // (possibly after a `claude mcp add <name> --` prefix).
    const commandLine = trimmed.split('\n').map((l) => l.trim()).find((l) => /^(npx|uvx|docker|node|python3?|bunx)\s/.test(l) || /\s--\s+(npx|uvx|docker|node)\s/.test(l));
    if (commandLine !== undefined) {
      const afterPrefix = /\s--\s+((?:npx|uvx|docker|node|python3?|bunx)\s[\s\S]+)$/.exec(commandLine)?.[1] ?? commandLine;
      return { endpoint: afterPrefix, installable: true, note: 'Local command from its mcpservers.org page.', secretSlots: detectSecretSlots(afterPrefix) };
    }
  }
  return { endpoint: '', installable: false, note: 'No installable configuration (remote URL or stdio command) was found on its mcpservers.org page. Add it manually with the Add server button.', secretSlots: [] };
}
