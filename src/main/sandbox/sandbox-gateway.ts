import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { SandboxApprovalPolicy, SandboxToolGroup } from '@shared/sandbox-agents';
import type { GateRequest } from '../adapters/tool-gate';
import type { ToolApprovalDecision } from '../adapters/tool-gate';
import type { SandboxEndpoint } from './sandbox-manager';

// The MCP server an agent CLI connects to for its sandbox tools.
//
// Each run gets a session at http://127.0.0.1:<port>/g/<token>/mcp. The
// gateway lists only the tool families the agent was given, and for every
// call decides — from the agent's approval policy — whether to ask the user
// through Conductor's approval gate before forwarding it to the sandbox's own
// MCP endpoint. The CLI never sees the sandbox's address or API key.

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Json : null);

const MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY = 4_000_000;
const KEEPALIVE_MS = 15_000;
/** Tool results can carry screenshots; keep them, but cap pathological sizes. */
const MAX_RESULT_CHARS = 2_000_000;

export interface GatewayTool { name: string; description?: string; inputSchema: Json }

// Tool names as the AIO Sandbox 1.11 MCP hub reports them (checked against a
// live container): browser_* (navigate, click, form_input_fill, screenshot,
// get_text, gui_execute_action, …), sandbox_execute_bash,
// sandbox_execute_code, sandbox_file_operations (one tool, `action` picks
// read/write/…), sandbox_str_replace_editor (`command` picks view/edit),
// sandbox_convert_to_markdown, and context tools (sandbox_get_context,
// sandbox_get_packages). Other spellings from older releases are accepted too.

/** Harmless context tools every agent gets, whatever families it has. */
const CONTEXT_TOOLS = new Set(['sandbox_get_context', 'sandbox_get_packages']);

/** Which family a sandbox tool belongs to, from its name. Unknown → undefined. */
export function toolGroup(name: string): SandboxToolGroup | undefined {
  const n = name.toLowerCase();
  if (n.startsWith('browser') || n.includes('_browser') || n.startsWith('page_') || n.startsWith('playwright')) return 'browser';
  if (n.startsWith('markitdown') || n.includes('convert_to_markdown')) return 'documents';
  if (n.startsWith('terminal') || n.startsWith('shell') || n.includes('bash') || n.startsWith('exec_command') || n.startsWith('run_command')) return 'shell';
  if (n.startsWith('jupyter') || n.startsWith('nodejs') || n.startsWith('code_') || n.includes('execute_code') || n.startsWith('python')) return 'code';
  if (n.startsWith('file') || n.includes('str_replace') || n.includes('_file') || n.startsWith('fs_') || n.startsWith('list_dir')) return 'files';
  return undefined;
}

/** Whether an agent with these families may see/call the tool. */
function allowedTool(name: string, groups: ReadonlySet<SandboxToolGroup>): boolean {
  if (CONTEXT_TOOLS.has(name.toLowerCase())) return true;
  const group = toolGroup(name);
  return group !== undefined && groups.has(group);
}

/** Calls that only look: listing, reading, screenshots, page content. */
export function isLookOnly(name: string, args: Json = {}): boolean {
  const n = name.toLowerCase();
  if (CONTEXT_TOOLS.has(n)) return true;
  const group = toolGroup(name);
  if (group === 'documents') return true;
  if (group === 'browser') {
    return /(screenshot|extract|get_|_get|read|content|text|markdown|html|info|tab|list|snapshot|scroll|wait|navigate|go_back|go_forward|open|close)/.test(n)
      && !/(click|type|fill|press|select|submit|upload|evaluate|execute|drag|hover)/.test(n);
  }
  if (group === 'files') {
    // One tool, many actions: decide from the action, not the name.
    const action = typeof args['action'] === 'string' ? args['action'].toLowerCase()
      : typeof args['command'] === 'string' ? args['command'].toLowerCase() : '';
    if (action !== '') return /^(read|view|list|search|find|grep|glob|stat|exists|info|tree)/.test(action);
    return /(read|list|search|find|stat|exists|view|glob|grep)/.test(n) && !/(write|replace|edit|delete|remove|move|rename|create|mkdir|upload)/.test(n);
  }
  return false;
}

export interface GatewaySessionConfig {
  sandbox: () => Promise<SandboxEndpoint>;
  tools: readonly SandboxToolGroup[];
  approval: SandboxApprovalPolicy;
  /** Conductor's gate for this run (permission profile + approval panel). */
  decide: (request: GateRequest, signal: AbortSignal) => Promise<ToolApprovalDecision>;
  /** Shown in approval cards, e.g. "Researcher". */
  agentName: string;
  /** Called after each forwarded call, for the thread's activity. */
  onCall?: (call: { tool: string; ok: boolean }) => void;
}

interface Session {
  config: GatewaySessionConfig;
  client?: Promise<Client>;
  tools?: Promise<GatewayTool[]>;
}

export interface GatewaySession {
  /** The MCP URL to hand the CLI. */
  url: string;
  /** Tools this run may use, for the agent's prompt. */
  toolNames(): Promise<string[]>;
  dispose(): void;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function clientGone(res: ServerResponse): AbortSignal {
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableFinished) controller.abort(); });
  return controller.signal;
}

/** One-line description of a call for the approval card. */
function describeCall(name: string, args: Json): { summary: string; detail?: string; kind: GateRequest['kind'] } {
  const group = toolGroup(name);
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) { const value = args[key]; if (typeof value === 'string' && value.trim() !== '') return value; }
    return undefined;
  };
  if (group === 'shell') {
    const command = pick('cmd', 'command', 'script', 'input');
    return { kind: 'command', summary: 'Run a command in the sandbox', ...(command !== undefined ? { detail: command } : {}) };
  }
  if (group === 'code') {
    const code = pick('code', 'source', 'script');
    return { kind: 'command', summary: 'Run code in the sandbox', ...(code !== undefined ? { detail: code } : {}) };
  }
  if (group === 'files') {
    const path = pick('path', 'file', 'file_path', 'filename', 'target');
    const action = pick('action', 'command');
    return { kind: 'file_change', summary: `${action !== undefined ? `${action[0]!.toUpperCase()}${action.slice(1)} a file` : 'Change a file'} in the sandbox${path !== undefined ? `: ${path}` : ''}`, ...(path !== undefined ? { detail: path } : {}) };
  }
  if (group === 'browser') {
    const index = typeof args['index'] === 'number' ? `element #${args['index']}` : undefined;
    const target = [pick('url', 'selector', 'text', 'element', 'ref', 'key', 'script'), index, pick('value')].filter((part) => part !== undefined).join(', ') || undefined;
    return { kind: 'permissions', summary: `Browser action: ${name.replace(/^browser_?/i, '').replace(/_/g, ' ')}`, ...(target !== undefined ? { detail: target } : {}) };
  }
  return { kind: 'permissions', summary: `Sandbox tool: ${name}`, detail: JSON.stringify(args).slice(0, 500) };
}

export class SandboxGateway {
  private server: Server | undefined;
  private listening: Promise<number> | undefined;
  private readonly sessions = new Map<string, Session>();

  async open(config: GatewaySessionConfig): Promise<GatewaySession> {
    const port = await this.listen();
    const token = randomBytes(24).toString('hex');
    const session: Session = { config };
    this.sessions.set(token, session);
    return {
      url: `http://127.0.0.1:${port}/g/${token}/mcp`,
      toolNames: async () => (await this.tools(session)).map((tool) => tool.name),
      dispose: () => {
        this.sessions.delete(token);
        void session.client?.then((client) => client.close()).catch(() => undefined);
      },
    };
  }

  close(): void {
    for (const session of this.sessions.values()) void session.client?.then((client) => client.close()).catch(() => undefined);
    this.sessions.clear();
    this.server?.close();
    this.server = undefined;
    this.listening = undefined;
  }

  // ---- upstream (the sandbox's own MCP endpoint) ----------------------------

  private client(session: Session): Promise<Client> {
    session.client ??= (async () => {
      const endpoint = await session.config.sandbox();
      const client = new Client({ name: 'conductor-sandbox-gateway', version: '0.1.0' });
      const transport = new StreamableHTTPClientTransport(new URL(`${endpoint.baseUrl}/mcp`), {
        requestInit: { headers: { 'X-AIO-API-Key': endpoint.apiKey } },
      });
      await client.connect(transport);
      return client;
    })().catch((error: unknown) => {
      delete session.client;
      throw error;
    });
    return session.client;
  }

  private tools(session: Session): Promise<GatewayTool[]> {
    session.tools ??= (async () => {
      const client = await this.client(session);
      const allowed = new Set(session.config.tools);
      const out: GatewayTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor !== undefined ? { cursor } : undefined);
        for (const tool of page.tools) {
          if (!allowedTool(tool.name, allowed)) continue;
          out.push({ name: tool.name, ...(tool.description !== undefined ? { description: tool.description } : {}), inputSchema: tool.inputSchema as Json });
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined && out.length < 500);
      return out;
    })().catch((error: unknown) => {
      delete session.tools;
      throw error;
    });
    return session.tools;
  }

  /** Approve (or not) and forward one tool call. */
  async call(session: Session, name: string, args: Json, signal: AbortSignal): Promise<Json> {
    const tools = await this.tools(session);
    if (!tools.some((tool) => tool.name === name)) {
      return { content: [{ type: 'text', text: `The tool ${name} is not available to this agent.` }], isError: true };
    }
    const { approval } = session.config;
    const needsApproval = approval === 'all' || (approval === 'risky' && !isLookOnly(name, args));
    if (needsApproval) {
      const described = describeCall(name, args);
      const decision = await session.config.decide({
        kind: described.kind,
        summary: `${session.config.agentName}: ${described.summary}`,
        ...(described.detail !== undefined ? { detail: described.detail } : {}),
        rememberKey: `sandbox:${name}:${described.kind === 'command' ? described.detail ?? '' : ''}`,
      }, signal);
      if (decision === 'cancel') return { content: [{ type: 'text', text: 'The run was stopped before this action was approved.' }], isError: true };
      if (decision === 'decline') {
        return { content: [{ type: 'text', text: 'The user declined this action. Do not retry it; continue another way or explain what you need.' }], isError: true };
      }
    }
    const client = await this.client(session);
    try {
      const result = await client.callTool({ name, arguments: args }, undefined, { signal, timeout: 10 * 60_000, resetTimeoutOnProgress: true });
      session.config.onCall?.({ tool: name, ok: result.isError !== true });
      const text = JSON.stringify(result);
      if (text.length > MAX_RESULT_CHARS) {
        return { content: [{ type: 'text', text: `${name} returned ${Math.round(text.length / 1000)} kB, more than the gateway passes on. Ask for a smaller result.` }], isError: true };
      }
      return result as Json;
    } catch (error) {
      session.config.onCall?.({ tool: name, ok: false });
      return { content: [{ type: 'text', text: `The sandbox could not run ${name}: ${error instanceof Error ? error.message : 'unknown error'}` }], isError: true };
    }
  }

  // ---- downstream (the CLI) -------------------------------------------------

  private listen(): Promise<number> {
    if (this.listening !== undefined) return this.listening;
    this.listening = new Promise<number>((resolve, reject) => {
      const server = createServer({ requestTimeout: 0 }, (req, res) => {
        void this.route(req, res, server).catch(() => {
          if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
          else res.end();
        });
      });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') { reject(new Error('sandbox gateway did not bind')); return; }
        server.unref();
        this.server = server;
        resolve(address.port);
      });
    });
    return this.listening;
  }

  private async route(req: IncomingMessage, res: ServerResponse, server: Server): Promise<void> {
    const address = server.address();
    const port = address !== null && typeof address === 'object' ? address.port : 0;
    // Loopback only, and no DNS-rebinding hosts.
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) { sendJson(res, 403, { error: 'forbidden' }); return; }
    const match = /^\/g\/([0-9a-f]{48})\/mcp$/.exec((req.url ?? '').split('?')[0] ?? '');
    const session = match !== null ? this.sessions.get(match[1]!) : undefined;
    if (session === undefined) { sendJson(res, 404, { error: 'unknown session' }); return; }
    if (req.method === 'DELETE') { res.writeHead(200); res.end(); return; }
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST, DELETE' }); res.end(); return; }
    let body: unknown;
    try { body = JSON.parse(await readBody(req)); } catch { sendJson(res, 400, { error: 'invalid JSON' }); return; }
    const message = obj(body);
    if (message === null) { sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batch requests are not supported' } }); return; }
    const id = message['id'];
    const method = typeof message['method'] === 'string' ? message['method'] : undefined;
    if (id === undefined || id === null || method === undefined) { res.writeHead(202); res.end(); return; }
    const params = obj(message['params']) ?? {};
    const reply = (result: unknown): void => { sendJson(res, 200, { jsonrpc: '2.0', id, result }); };
    const fail = (text: string): void => { sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32603, message: text } }); };

    switch (method) {
      case 'initialize': {
        const requested = typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : '';
        reply({
          protocolVersion: MCP_VERSIONS.includes(requested) ? requested : MCP_VERSIONS[1],
          capabilities: { tools: {} },
          serverInfo: { name: 'conductor-sandbox', version: '0.1.0' },
          instructions: 'Tools that run inside an isolated sandbox computer with a real web browser, a terminal and files. Some actions wait for the user to approve them.',
        });
        return;
      }
      case 'ping':
        reply({});
        return;
      case 'tools/list':
        try { reply({ tools: await this.tools(session) }); }
        catch (error) { fail(`The sandbox is not reachable: ${error instanceof Error ? error.message : 'unknown error'}`); }
        return;
      case 'tools/call': {
        const name = typeof params['name'] === 'string' ? params['name'] : '';
        // Approvals and browser work take a while: stream the answer with
        // keepalives so the CLI's HTTP client does not time out.
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': working\n\n');
        const keepalive = setInterval(() => { res.write(': keepalive\n\n'); }, KEEPALIVE_MS);
        try {
          const result = await this.call(session, name, obj(params['arguments']) ?? {}, clientGone(res));
          res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`);
        } catch (error) {
          res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: error instanceof Error ? error.message : 'Sandbox error' }], isError: true } })}\n\n`);
        } finally {
          clearInterval(keepalive);
          res.end();
        }
        return;
      }
      default:
        sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  }
}
