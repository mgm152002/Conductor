import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import {
  MCP_CLI_IDS, MCP_CLI_NAMES,
  type CliMcpAddInput, type CliMcpEntry, type CliMcpOverview, type CliMcpPresence, type CliMcpServerView,
  type CliMcpSyncReport, type McpCliId, type PortableMcpServer,
} from '@shared/cli-mcp';
import { splitCommandLine } from './sdk-transport';

// MCP servers installed into each agent CLI's own configuration.
//
// Reads go straight to each CLI's config (Codex through `codex mcp list
// --json`, which owns its TOML); writes go through each CLI's own `mcp add` /
// `mcp remove` command so the CLI keeps its file format and validation. The
// one exception is removing from OpenCode, which has no remove command: its
// JSON config is edited in place, atomically.
//
// Sync is optional and add-only: when the user turns it on (or presses Sync),
// a portable server present in any CLI is installed into every other
// installed CLI that lacks it. Removing a server from one CLI on
// purpose records an exclusion so sync does not put it back; "remove
// everywhere" removes it from all CLIs instead.

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | null => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : null);
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
const record = (value: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(obj(value) ?? {})) if (typeof item === 'string') out[key] = item;
  return out;
};

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const COMMAND_TIMEOUT_MS = 45_000;

/** A CLI's server with its full definition (values included; main only). */
interface FullEntry { cli: McpCliId; name: string; server: PortableMcpServer; disabled: boolean; portable: boolean; note?: string }

/** Runs one CLI command; injectable for tests. */
export type CliRunner = (executable: string, args: string[]) => Promise<{ stdout: string }>;

export interface CliMcpManagerOptions {
  home?: string;
  /** Where sync preferences are stored. */
  statePath: string;
  run?: CliRunner;
  /** Resolve a CLI binary on PATH; undefined when it is not installed. */
  which?: (binary: string) => string | undefined;
}

interface SyncState { autoSync: boolean; excluded: string[] }

const BINARIES: Record<McpCliId, string> = {
  'claude-code': 'claude', codex: 'codex', opencode: 'opencode', antigravity: 'agy', kiro: 'kiro-cli',
};

function searchPath(): string[] {
  const home = homedir();
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', join(home, '.local/bin'), join(home, '.npm-global/bin'), join(home, '.opencode/bin'), '/usr/bin', '/bin'];
  return [...new Set([...(process.env['PATH'] ?? '').split(delimiter), ...extra])].filter(Boolean);
}

function defaultWhich(binary: string): string | undefined {
  for (const dir of searchPath()) {
    const candidate = join(dir, binary);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const defaultRun: CliRunner = (executable, args) => new Promise((resolve, reject) => {
  execFile(executable, args, {
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, PATH: searchPath().join(delimiter) },
    cwd: homedir(),
  }, (error, stdout, stderr) => {
    if (error !== null) {
      // The CLI's own message is the useful part; never echo the arguments,
      // which can carry credentials.
      const detail = `${stderr}`.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? error.message.split('\n')[0] ?? 'failed';
      reject(new Error(detail.slice(0, 300)));
      return;
    }
    resolve({ stdout: `${stdout}` });
  });
});

/** Command line for display: `npx -y pkg` with quoting where needed. */
function displayCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map((part) => (/^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`)).join(' ');
}

function endpointOf(server: PortableMcpServer): string {
  return server.transport === 'http' ? server.url ?? '' : displayCommand(server.command ?? '', server.args ?? []);
}

/** Whether a stdio definition depends on where/how this one CLI launches it. */
function stdioPortability(command: string, cwd: string | undefined, inherited: readonly string[]): { portable: boolean; note?: string } {
  if (cwd !== undefined && cwd !== '') return { portable: false, note: 'Runs from a working directory only this CLI knows.' };
  if (command.startsWith('./') || command.startsWith('../') || (!isAbsolute(command) && command.includes('/'))) {
    return { portable: false, note: 'Uses a path relative to this CLI.' };
  }
  if (inherited.length > 0) return { portable: false, note: 'Relies on environment this CLI passes through.' };
  if (/\/\.codex\/plugins\//.test(command)) return { portable: false, note: 'Bundled with Codex.' };
  return { portable: true };
}

/** Parse a `{ name: { command, args, env, url, headers, ... } }` map used by most CLIs. */
function parseStandardMap(cli: McpCliId, map: Json): FullEntry[] {
  const entries: FullEntry[] = [];
  for (const [name, raw] of Object.entries(map)) {
    const def = obj(raw);
    if (def === null) continue;
    const disabled = def['disabled'] === true || def['enabled'] === false;
    const url = str(def['url']) ?? str(def['serverUrl']) ?? str(def['httpUrl']);
    if (url !== undefined) {
      const headers = record(def['headers']);
      entries.push({ cli, name, disabled, portable: true, server: { name, transport: 'http', url, ...(Object.keys(headers).length > 0 ? { headers } : {}) } });
      continue;
    }
    const command = str(def['command']);
    if (command === undefined) continue;
    const env = record(def['env']);
    const portability = stdioPortability(command, str(def['cwd']), []);
    entries.push({
      cli, name, disabled, ...portability,
      server: { name, transport: 'stdio', command, args: strings(def['args']), ...(Object.keys(env).length > 0 ? { env } : {}) },
    });
  }
  return entries;
}

async function readJson(path: string): Promise<Json | null> {
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch { return null; }
  if (text.trim() === '') return {};
  try { return obj(JSON.parse(text)) ?? {}; } catch { throw new Error(`${path} is not valid JSON`); }
}

export class CliMcpManager {
  private readonly home: string;
  private readonly run: CliRunner;
  private readonly which: (binary: string) => string | undefined;
  private readonly statePath: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: CliMcpManagerOptions) {
    this.home = options.home ?? homedir();
    this.run = options.run ?? defaultRun;
    this.which = options.which ?? defaultWhich;
    this.statePath = options.statePath;
  }

  /** Writes to CLI configs run one at a time so two edits never race. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  configPath(cli: McpCliId): string {
    switch (cli) {
      case 'claude-code': return join(this.home, '.claude.json');
      case 'codex': return join(this.home, '.codex', 'config.toml');
      case 'opencode': return this.openCodeConfigPath();
      case 'antigravity': return join(this.home, '.gemini', 'antigravity', 'mcp_config.json');
      case 'kiro': return join(this.home, '.kiro', 'settings', 'mcp.json');
    }
  }

  private openCodeConfigPath(): string {
    const base = process.env['XDG_CONFIG_HOME'] ?? join(this.home, '.config');
    const json = join(base, 'opencode', 'opencode.json');
    const jsonc = join(base, 'opencode', 'opencode.jsonc');
    return !existsSync(json) && existsSync(jsonc) ? jsonc : json;
  }

  private executable(cli: McpCliId): string | undefined {
    return this.which(BINARIES[cli]);
  }

  /** Every server one CLI has configured globally, with full definitions. */
  private async readCli(cli: McpCliId): Promise<FullEntry[]> {
    switch (cli) {
      case 'codex': {
        const exe = this.executable('codex');
        if (exe === undefined) return [];
        const { stdout } = await this.run(exe, ['mcp', 'list', '--json']);
        const list = JSON.parse(stdout) as unknown;
        const out: FullEntry[] = [];
        for (const raw of Array.isArray(list) ? list : []) {
          const item = obj(raw);
          const name = str(item?.['name']);
          const transport = obj(item?.['transport']);
          if (item === null || name === undefined || transport === null) continue;
          const disabled = item['enabled'] === false;
          const url = str(transport['url']);
          if (url !== undefined) {
            const headers = record(transport['http_headers'] ?? transport['headers']);
            out.push({ cli, name, disabled, portable: true, server: { name, transport: 'http', url, ...(Object.keys(headers).length > 0 ? { headers } : {}) } });
            continue;
          }
          const command = str(transport['command']);
          if (command === undefined) continue;
          const env = record(transport['env']);
          out.push({
            cli, name, disabled, ...stdioPortability(command, str(transport['cwd']) ?? undefined, strings(transport['env_vars'])),
            server: { name, transport: 'stdio', command, args: strings(transport['args']), ...(Object.keys(env).length > 0 ? { env } : {}) },
          });
        }
        return out;
      }
      case 'opencode': {
        const path = this.openCodeConfigPath();
        if (path.endsWith('.jsonc')) {
          // Comments are allowed there; read best-effort without them.
          let text = '';
          try { text = await readFile(path, 'utf8'); } catch { return []; }
          const stripped = text.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, quoted: string | undefined) => quoted ?? '');
          return this.parseOpenCode(obj(JSON.parse(stripped.replace(/,(\s*[}\]])/g, '$1'))) ?? {});
        }
        const config = await readJson(path);
        return config === null ? [] : this.parseOpenCode(config);
      }
      case 'claude-code': {
        const config = await readJson(this.configPath(cli));
        return config === null ? [] : parseStandardMap(cli, obj(config['mcpServers']) ?? {});
      }
      case 'antigravity':
      case 'kiro': {
        const config = await readJson(this.configPath(cli));
        return config === null ? [] : parseStandardMap(cli, obj(config['mcpServers']) ?? {});
      }
    }
  }

  private parseOpenCode(config: Json): FullEntry[] {
    const out: FullEntry[] = [];
    for (const [name, raw] of Object.entries(obj(config['mcp']) ?? {})) {
      const def = obj(raw);
      if (def === null) continue;
      const disabled = def['enabled'] === false;
      if (def['type'] === 'remote' || typeof def['url'] === 'string') {
        const url = str(def['url']);
        if (url === undefined) continue;
        const headers = record(def['headers']);
        out.push({ cli: 'opencode', name, disabled, portable: true, server: { name, transport: 'http', url, ...(Object.keys(headers).length > 0 ? { headers } : {}) } });
        continue;
      }
      const argv = strings(def['command']);
      if (argv.length === 0) continue;
      const env = record(def['environment']);
      out.push({
        cli: 'opencode', name, disabled, ...stdioPortability(argv[0]!, undefined, []),
        server: { name, transport: 'stdio', command: argv[0]!, args: argv.slice(1), ...(Object.keys(env).length > 0 ? { env } : {}) },
      });
    }
    return out;
  }

  /** Why a CLI cannot hold this server as-is, if it cannot. */
  private unsupported(cli: McpCliId, server: PortableMcpServer): string | undefined {
    const headers = Object.keys(server.headers ?? {});
    if (server.transport === 'http' && headers.length > 0 && (cli === 'codex' || cli === 'kiro')) {
      return `${MCP_CLI_NAMES[cli]} cannot store HTTP headers from the command line (${headers.join(', ')}).`;
    }
    return undefined;
  }

  private addArgs(cli: McpCliId, server: PortableMcpServer): string[] {
    const env = Object.entries(server.env ?? {});
    const headers = Object.entries(server.headers ?? {});
    const http = server.transport === 'http';
    const url = server.url ?? '';
    const command = server.command ?? '';
    const args = server.args ?? [];
    switch (cli) {
      case 'claude-code':
        return ['mcp', 'add', '--scope', 'user',
          ...(http ? ['--transport', 'http', ...headers.flatMap(([k, v]) => ['--header', `${k}: ${v}`])] : env.flatMap(([k, v]) => ['--env', `${k}=${v}`])),
          server.name, ...(http ? [url] : ['--', command, ...args])];
      case 'codex':
        return http
          ? ['mcp', 'add', server.name, '--url', url]
          : ['mcp', 'add', server.name, ...env.flatMap(([k, v]) => ['--env', `${k}=${v}`]), '--', command, ...args];
      case 'opencode':
        return http
          ? ['mcp', 'add', '--global', ...headers.flatMap(([k, v]) => ['--header', `${k}=${v}`]), '--url', url, server.name]
          : ['mcp', 'add', '--global', ...env.flatMap(([k, v]) => ['--env', `${k}=${v}`]), server.name, '--', command, ...args];
      case 'antigravity':
        // Flags must come before the name.
        return http
          ? ['mcp', 'add', ...headers.flatMap(([k, v]) => ['--header', `${k}: ${v}`]), server.name, url]
          : ['mcp', 'add', ...env.flatMap(([k, v]) => ['--env', `${k}=${v}`]), server.name, '--', command, ...args];
      case 'kiro':
        return http
          ? ['mcp', 'add', '--scope', 'global', '--name', server.name, '--url', url]
          : ['mcp', 'add', '--scope', 'global', '--name', server.name, '--command', command,
            ...(args.length > 0 ? ['--args', JSON.stringify(args)] : []),
            ...env.flatMap(([k, v]) => ['--env', `${k}=${v}`])];
    }
  }

  private async installInto(cli: McpCliId, server: PortableMcpServer): Promise<void> {
    const exe = this.executable(cli);
    if (exe === undefined) throw new Error(`${MCP_CLI_NAMES[cli]} is not installed`);
    const reason = this.unsupported(cli, server);
    if (reason !== undefined) throw new Error(reason);
    await this.run(exe, this.addArgs(cli, server));
  }

  private async removeFrom(cli: McpCliId, name: string): Promise<void> {
    const exe = this.executable(cli);
    if (cli === 'opencode') {
      // OpenCode has no remove command; edit its JSON config atomically.
      const path = this.openCodeConfigPath();
      if (path.endsWith('.jsonc')) throw new Error('OpenCode uses opencode.jsonc here; remove the server from that file by hand.');
      const config = await readJson(path);
      const mcp = obj(config?.['mcp']);
      if (config === null || mcp === null || !(name in mcp)) return;
      delete mcp[name];
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.conductor-${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      await rename(temp, path);
      return;
    }
    if (exe === undefined) throw new Error(`${MCP_CLI_NAMES[cli]} is not installed`);
    const args = cli === 'claude-code' ? ['mcp', 'remove', '--scope', 'user', name]
      : cli === 'kiro' ? ['mcp', 'remove', '--scope', 'global', '--name', name]
        : ['mcp', 'remove', name];
    await this.run(exe, args);
  }

  // ---- sync preferences ------------------------------------------------------

  private async state(): Promise<SyncState> {
    try {
      const raw = obj(JSON.parse(await readFile(this.statePath, 'utf8')));
      return { autoSync: raw?.['autoSync'] === true, excluded: strings(raw?.['excluded']) };
    } catch {
      // Off until the user turns it on: syncing writes to every CLI's config.
      return { autoSync: false, excluded: [] };
    }
  }

  private async saveState(state: SyncState): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    await writeFile(this.statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  }

  private static exclusion(cli: McpCliId, key: string): string { return `${cli}:${key}`; }

  async setAutoSync(enabled: boolean): Promise<CliMcpOverview> {
    await this.saveState({ ...(await this.state()), autoSync: enabled });
    return this.overview({ sync: enabled });
  }

  // ---- reads -----------------------------------------------------------------

  private async readAll(): Promise<{ entries: FullEntry[]; errors: Partial<Record<McpCliId, string>> }> {
    const errors: Partial<Record<McpCliId, string>> = {};
    const results = await Promise.all(MCP_CLI_IDS.map(async (cli) => {
      if (this.executable(cli) === undefined) return [];
      try { return await this.readCli(cli); }
      catch (error) { errors[cli] = error instanceof Error ? error.message : 'Could not read its MCP configuration'; return []; }
    }));
    return { entries: results.flat(), errors };
  }

  /**
   * The servers across every installed CLI. With `sync`, first installs each
   * portable server into every installed CLI that lacks it (unless excluded).
   */
  async overview(options: { sync?: boolean } = {}): Promise<CliMcpOverview> {
    const state = await this.state();
    let report: CliMcpSyncReport | undefined;
    if (options.sync === true && state.autoSync) report = await this.sync();
    const { entries, errors } = await this.readAll();
    const installed = MCP_CLI_IDS.filter((cli) => this.executable(cli) !== undefined);
    const groups = new Map<string, FullEntry[]>();
    for (const entry of entries) {
      const key = entry.name.toLowerCase();
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    const servers: CliMcpServerView[] = [...groups.entries()].map(([key, list]) => {
      const source = list.find((entry) => entry.portable) ?? list[0]!;
      const presence: Partial<Record<McpCliId, CliMcpPresence>> = {};
      for (const cli of installed) {
        const here = list.find((entry) => entry.cli === cli);
        if (here !== undefined) presence[cli] = { state: 'installed', entry: this.view(here) };
        else if (state.excluded.includes(CliMcpManager.exclusion(cli, key))) presence[cli] = { state: 'excluded' };
        else {
          const reason = this.unsupported(cli, source.server);
          presence[cli] = reason !== undefined ? { state: 'unsupported', reason } : { state: 'missing' };
        }
      }
      const view = this.view(source);
      return {
        key, name: source.name, transport: view.transport, endpoint: view.endpoint,
        envNames: view.envNames, headerNames: view.headerNames,
        portable: list.some((entry) => entry.portable),
        ...(source.note !== undefined && !list.some((entry) => entry.portable) ? { note: source.note } : {}),
        presence,
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
    return {
      clis: MCP_CLI_IDS.map((cli) => ({
        id: cli, name: MCP_CLI_NAMES[cli], installed: installed.includes(cli), configPath: this.configPath(cli).replace(this.home, '~'),
        ...(errors[cli] !== undefined ? { error: errors[cli] } : {}),
      })),
      servers,
      autoSync: state.autoSync,
      ...(report !== undefined ? { sync: report } : {}),
    };
  }

  private view(entry: FullEntry): CliMcpEntry {
    return {
      cli: entry.cli, name: entry.name, transport: entry.server.transport, endpoint: endpointOf(entry.server),
      envNames: Object.keys(entry.server.env ?? {}), headerNames: Object.keys(entry.server.headers ?? {}),
      disabled: entry.disabled, portable: entry.portable, ...(entry.note !== undefined ? { note: entry.note } : {}),
    };
  }

  // ---- writes ----------------------------------------------------------------

  /** Install every portable server into each installed CLI that lacks it. */
  sync(): Promise<CliMcpSyncReport> {
    return this.serial(async () => {
      const state = await this.state();
      const { entries } = await this.readAll();
      const installed = MCP_CLI_IDS.filter((cli) => this.executable(cli) !== undefined);
      const report: CliMcpSyncReport = { installed: [], failed: [] };
      const byKey = new Map<string, FullEntry[]>();
      for (const entry of entries) byKey.set(entry.name.toLowerCase(), [...(byKey.get(entry.name.toLowerCase()) ?? []), entry]);
      for (const [key, list] of byKey) {
        const source = list.find((entry) => entry.portable && !entry.disabled);
        if (source === undefined || !NAME.test(source.name)) continue;
        for (const cli of installed) {
          if (list.some((entry) => entry.cli === cli)) continue;
          if (state.excluded.includes(CliMcpManager.exclusion(cli, key))) continue;
          if (this.unsupported(cli, source.server) !== undefined) continue;
          try {
            await this.installInto(cli, source.server);
            report.installed.push({ cli, name: source.name });
          } catch (error) {
            report.failed.push({ cli, name: source.name, error: error instanceof Error ? error.message : 'failed' });
          }
        }
      }
      return report;
    });
  }

  /** Install a new server into the chosen CLIs (all installed CLIs by default). */
  add(input: CliMcpAddInput): Promise<CliMcpOverview> {
    return this.serial(async () => {
      const name = input.name.trim();
      if (!NAME.test(name)) throw new Error('Use a name of letters, digits, dots, dashes or underscores (up to 64), starting with a letter or digit.');
      const endpoint = input.endpoint.trim();
      let server: PortableMcpServer;
      if (/^https?:\/\//i.test(endpoint)) {
        const url = new URL(endpoint);
        const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
        if (url.protocol === 'http:' && !local) throw new Error('Remote MCP servers must use https://');
        server = { name, transport: 'http', url: endpoint, ...(input.headers !== undefined && Object.keys(input.headers).length > 0 ? { headers: input.headers } : {}) };
      } else {
        const argv = splitCommandLine(endpoint);
        if (argv.length === 0) throw new Error('Enter a command or an https:// URL.');
        server = { name, transport: 'stdio', command: argv[0]!, args: argv.slice(1), ...(input.env !== undefined && Object.keys(input.env).length > 0 ? { env: input.env } : {}) };
      }
      const targets = (input.clis ?? MCP_CLI_IDS).filter((cli) => this.executable(cli) !== undefined);
      if (targets.length === 0) throw new Error('None of the chosen CLIs is installed.');
      const { entries } = await this.readAll();
      const key = name.toLowerCase();
      const failures: string[] = [];
      for (const cli of targets) {
        if (entries.some((entry) => entry.cli === cli && entry.name.toLowerCase() === key)) continue;
        try { await this.installInto(cli, server); }
        catch (error) { failures.push(`${MCP_CLI_NAMES[cli]}: ${error instanceof Error ? error.message : 'failed'}`); }
      }
      // A fresh install is wanted everywhere it was sent; drop old exclusions.
      const state = await this.state();
      await this.saveState({ ...state, excluded: state.excluded.filter((item) => !targets.some((cli) => item === CliMcpManager.exclusion(cli, key))) });
      if (failures.length === targets.length) throw new Error(`Could not install ${name}. ${failures.join(' ')}`);
      const overview = await this.overview();
      return failures.length > 0 ? { ...overview, sync: { installed: [], failed: failures.map((text) => ({ cli: targets[0]!, name, error: text })) } } : overview;
    });
  }

  /** Copy an existing server into one more CLI (the "+" on a missing chip). */
  installExisting(key: string, cli: McpCliId): Promise<CliMcpOverview> {
    return this.serial(async () => {
      const { entries } = await this.readAll();
      const source = entries.find((entry) => entry.name.toLowerCase() === key && entry.portable);
      if (source === undefined) throw new Error('That server only works in the CLI that has it.');
      await this.installInto(cli, source.server);
      const state = await this.state();
      await this.saveState({ ...state, excluded: state.excluded.filter((item) => item !== CliMcpManager.exclusion(cli, key)) });
      return this.overview();
    });
  }

  /** Remove from one CLI and keep sync from re-adding it there. */
  removeFromCli(key: string, cli: McpCliId): Promise<CliMcpOverview> {
    return this.serial(async () => {
      const { entries } = await this.readAll();
      const entry = entries.find((item) => item.cli === cli && item.name.toLowerCase() === key);
      if (entry !== undefined) await this.removeFrom(cli, entry.name);
      const state = await this.state();
      const exclusion = CliMcpManager.exclusion(cli, key);
      if (!state.excluded.includes(exclusion)) await this.saveState({ ...state, excluded: [...state.excluded, exclusion] });
      return this.overview();
    });
  }

  /** Remove from every CLI that has it. */
  removeEverywhere(key: string): Promise<CliMcpOverview> {
    return this.serial(async () => {
      const { entries } = await this.readAll();
      const failures: string[] = [];
      for (const entry of entries.filter((item) => item.name.toLowerCase() === key)) {
        try { await this.removeFrom(entry.cli, entry.name); }
        catch (error) { failures.push(`${MCP_CLI_NAMES[entry.cli]}: ${error instanceof Error ? error.message : 'failed'}`); }
      }
      const state = await this.state();
      await this.saveState({ ...state, excluded: state.excluded.filter((item) => !item.endsWith(`:${key}`)) });
      if (failures.length > 0) throw new Error(`Could not remove it everywhere. ${failures.join(' ')}`);
      return this.overview();
    });
  }
}
