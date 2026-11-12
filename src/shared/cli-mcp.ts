// MCP servers as each agent CLI sees them: installed into the CLI's own
// configuration (Claude Code, Codex, OpenCode, Antigravity, Kiro), not into a
// Conductor-side registry. Shared by main and renderer.

/** The agent CLIs whose MCP configuration Conductor can read and write. */
export type McpCliId = 'claude-code' | 'codex' | 'opencode' | 'antigravity' | 'kiro';

export const MCP_CLI_IDS: readonly McpCliId[] = ['claude-code', 'codex', 'opencode', 'antigravity', 'kiro'];

export const MCP_CLI_NAMES: Record<McpCliId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  antigravity: 'Antigravity',
  kiro: 'Kiro',
};

/**
 * A server definition that can be written to any CLI. Values in `env` and
 * `headers` stay in the main process; the renderer only sees their names.
 */
export interface PortableMcpServer {
  name: string;
  transport: 'stdio' | 'http';
  /** stdio: the executable. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http: the server URL. */
  url?: string;
  headers?: Record<string, string>;
}

/** One CLI's copy of a server, as shown in the renderer (no secret values). */
export interface CliMcpEntry {
  cli: McpCliId;
  /** The name the CLI stores it under. */
  name: string;
  transport: 'stdio' | 'http';
  /** Command line or URL, for display. */
  endpoint: string;
  envNames: string[];
  headerNames: string[];
  disabled: boolean;
  /**
   * False when the definition only works inside this CLI (a relative path,
   * a working directory, inherited CLI environment, or a bundled plugin), so
   * it is never copied to other CLIs.
   */
  portable: boolean;
  /** Why it is not portable, when it is not. */
  note?: string;
}

/** Per-CLI state of one server in the overview. */
export type CliMcpPresence =
  | { state: 'installed'; entry: CliMcpEntry }
  | { state: 'missing' }
  /** Removed from this CLI on purpose; sync leaves it alone. */
  | { state: 'excluded' }
  /** This CLI cannot hold this server (for example headers it does not support). */
  | { state: 'unsupported'; reason: string };

export interface CliMcpServerView {
  /** Lower-cased name, the key servers are matched by across CLIs. */
  key: string;
  name: string;
  transport: 'stdio' | 'http';
  endpoint: string;
  envNames: string[];
  headerNames: string[];
  portable: boolean;
  note?: string;
  presence: Partial<Record<McpCliId, CliMcpPresence>>;
}

export interface CliMcpCliView {
  id: McpCliId;
  name: string;
  /** The CLI binary was found on PATH. */
  installed: boolean;
  /** Where its MCP configuration lives, for display. */
  configPath: string;
  /** Reading its configuration failed. */
  error?: string;
}

export interface CliMcpOverview {
  clis: CliMcpCliView[];
  servers: CliMcpServerView[];
  autoSync: boolean;
  /** Results of the sync that ran with this read, if any. */
  sync?: CliMcpSyncReport;
}

export interface CliMcpSyncReport {
  installed: Array<{ cli: McpCliId; name: string }>;
  failed: Array<{ cli: McpCliId; name: string; error: string }>;
}

/** What the add form sends. Secret values cross IPC only here, once. */
export interface CliMcpAddInput {
  name: string;
  /** A command line (stdio) or an http(s) URL. */
  endpoint: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  /** CLIs to install into; all installed CLIs when omitted. */
  clis?: McpCliId[];
}
