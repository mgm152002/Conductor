import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpDiscoveryEntry, McpHealthProbeResult, McpServer, McpServerCapability, McpTransport } from '@shared/mcp';

// Production McpTransport over the official Model Context Protocol SDK.
//
// Endpoint format (stored on the server record, never a secret):
//   * `https://…` / `http://localhost…` → Streamable HTTP
//   * anything else → a command line launched over stdio, e.g.
//     `npx -y @modelcontextprotocol/server-filesystem /Users/me/notes`
//
// Safety: nothing is spawned or contacted for a server the user has not
// approved and enabled. Discovery only reads MCP config files other tools
// already keep on this Mac; it never launches the servers it finds.

export interface ParsedEndpoint {
  kind: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: URL;
}

/** Split a command line into argv, honouring single/double quotes and backslash escapes. */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote !== null) {
      if (ch === quote) { quote = null; continue; }
      if (ch === '\\' && quote === '"' && i + 1 < line.length) { current += line[++i]; continue; }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (ch === '\\' && i + 1 < line.length) { current += line[++i]; has = true; continue; }
    if (/\s/.test(ch)) { if (has || current) { out.push(current); current = ''; has = false; } continue; }
    current += ch;
    has = true;
  }
  if (quote !== null) throw new Error('Unterminated quote in command');
  if (has || current) out.push(current);
  return out;
}

export function parseEndpoint(endpoint: string): ParsedEndpoint {
  const trimmed = endpoint.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol === 'http:' && !local) throw new Error('Remote MCP servers must use https://');
    return { kind: 'http', url };
  }
  const argv = splitCommandLine(trimmed);
  if (argv.length === 0) throw new Error('Enter a command or https:// URL');
  return { kind: 'stdio', command: argv[0]!, args: argv.slice(1) };
}

function augmentedPath(): string {
  const base = process.env['PATH'] ?? '';
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local/bin'), join(homedir(), '.npm-global/bin'), '/usr/bin', '/bin'];
  return [...new Set([...base.split(delimiter), ...extra])].filter(Boolean).join(delimiter);
}

interface Connection { client: Client; close: () => Promise<void> }

export class SdkMcpTransport implements McpTransport {
  private readonly connections = new Map<string, Promise<Connection>>();

  constructor(private readonly configSources: readonly { label: string; path: string }[] = defaultConfigSources()) {}

  /** Reads MCP server definitions from other tools' config files. Launches nothing. */
  async discover(): Promise<McpDiscoveryEntry[]> {
    const found = new Map<string, McpDiscoveryEntry>();
    for (const source of this.configSources) {
      let text: string;
      try { text = await readFile(source.path, 'utf8'); } catch { continue; }
      for (const entry of parseConfigFile(source, text)) if (!found.has(entry.id)) found.set(entry.id, entry);
    }
    return [...found.values()];
  }

  async probeHealth(server: McpServer): Promise<McpHealthProbeResult> {
    if (server.trustStatus !== 'trusted' || server.enablement !== 'enabled') {
      return { healthy: false, detail: 'Not approved and enabled; not contacted' };
    }
    try {
      const { client } = await this.connect(server);
      await client.ping();
      return { healthy: true };
    } catch (error) {
      await this.disconnect(server.id);
      return { healthy: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /** The server's tools as registry capabilities. Only call for an approved server. */
  async listTools(server: McpServer): Promise<McpServerCapability[]> {
    const { client } = await this.connect(server);
    const tools: McpServerCapability[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor !== undefined ? { cursor } : undefined);
      for (const tool of page.tools) tools.push({ id: tool.name, title: tool.title ?? tool.description?.split('\n')[0]?.slice(0, 200) ?? tool.name });
      cursor = page.nextCursor;
    } while (cursor !== undefined && tools.length < 500);
    return tools;
  }

  async invoke(server: McpServer, capabilityId: string, args: unknown, signal: AbortSignal): Promise<unknown> {
    const { client } = await this.connect(server);
    const input = args !== null && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
    return client.callTool({ name: capabilityId, arguments: input }, undefined, { signal });
  }

  async disconnect(serverId: string): Promise<void> {
    const pending = this.connections.get(serverId);
    this.connections.delete(serverId);
    if (pending === undefined) return;
    try { await (await pending).close(); } catch { /* already closed */ }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)));
  }

  private connect(server: McpServer): Promise<Connection> {
    if (server.trustStatus !== 'trusted' || server.enablement !== 'enabled') {
      return Promise.reject(new Error('MCP server is not approved and enabled'));
    }
    const existing = this.connections.get(server.id);
    if (existing !== undefined) return existing;
    const pending = (async (): Promise<Connection> => {
      const endpoint = parseEndpoint(server.endpoint);
      const client = new Client({ name: 'conductor', version: '0.1.0' });
      const transport = endpoint.kind === 'http'
        ? new StreamableHTTPClientTransport(endpoint.url!)
        : new StdioClientTransport({
          command: endpoint.command!,
          args: endpoint.args ?? [],
          env: { ...getDefaultEnvironment(), PATH: augmentedPath() },
          stderr: 'ignore',
        });
      transport.onclose = () => { this.connections.delete(server.id); };
      await client.connect(transport);
      return { client, close: () => client.close() };
    })();
    pending.catch(() => { this.connections.delete(server.id); });
    this.connections.set(server.id, pending);
    return pending;
  }
}

export function defaultConfigSources(): { label: string; path: string }[] {
  const home = homedir();
  return [
    { label: 'claude-desktop', path: join(home, 'Library/Application Support/Claude/claude_desktop_config.json') },
    { label: 'cursor', path: join(home, '.cursor/mcp.json') },
    { label: 'kiro', path: join(home, '.kiro/settings/mcp.json') },
    { label: 'vscode', path: join(home, 'Library/Application Support/Code/User/mcp.json') },
    { label: 'codex', path: join(home, '.codex/config.toml') },
  ];
}

function quoteArg(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Parse one config file into discovery entries. Servers whose definitions
 * carry environment variables or headers are skipped (those usually hold
 * credentials, which must not be copied into an endpoint string).
 */
export function parseConfigFile(source: { label: string }, text: string): McpDiscoveryEntry[] {
  const entries: McpDiscoveryEntry[] = [];
  const add = (name: string, def: { command?: unknown; args?: unknown; url?: unknown; env?: unknown; headers?: unknown; disabled?: unknown }): void => {
    if (def.disabled === true) return;
    if ((def.env !== undefined && Object.keys(def.env as object).length > 0) || def.headers !== undefined) return;
    let endpoint: string | undefined;
    if (typeof def.url === 'string') endpoint = def.url;
    else if (typeof def.command === 'string') {
      const args = Array.isArray(def.args) ? def.args.filter((a): a is string => typeof a === 'string') : [];
      endpoint = [def.command, ...args].map(quoteArg).join(' ');
    }
    if (endpoint === undefined) return;
    const id = `${source.label}.${name}`.toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 120);
    entries.push({ id, name, endpoint, trustStatus: 'untrusted', registrationState: 'discovered' });
  };
  if (source.label === 'codex') {
    // Minimal TOML: [mcp_servers.<name>] tables with command / args / url keys.
    const blocks = text.split(/^\s*\[mcp_servers\.([^\]\s]+)\]\s*$/m);
    for (let i = 1; i < blocks.length; i += 2) {
      const name = blocks[i]!.replace(/^"|"$/g, '');
      const body = (blocks[i + 1] ?? '').split(/^\s*\[/m)[0] ?? '';
      const str = (key: string): string | undefined => new RegExp(`^\\s*${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'm').exec(body)?.[1];
      const argsRaw = /^\s*args\s*=\s*\[([^\]]*)\]/m.exec(body)?.[1];
      const args = argsRaw !== undefined ? [...argsRaw.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!) : [];
      const hasEnv = /^\s*env\s*=|^\s*\[mcp_servers\.[^\]]+\.env\]/m.test(body);
      add(name, { command: str('command'), args, url: str('url'), ...(hasEnv ? { env: { present: true } } : {}) });
    }
    return entries;
  }
  try {
    const parsed = JSON.parse(text) as { mcpServers?: Record<string, object>; servers?: Record<string, object> };
    for (const [name, def] of Object.entries(parsed.mcpServers ?? parsed.servers ?? {})) add(name, def as Parameters<typeof add>[1]);
  } catch { /* unreadable config */ }
  return entries;
}
