import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';

// A loopback HTTP endpoint that agent CLIs call back into before a tool runs:
//
//  - POST /s/<token>/hook   Antigravity's PreToolUse hook (a curl one-liner)
//                           sends the hook payload and gets the hook decision.
//  - POST /s/<token>/mcp    A minimal MCP server (Streamable HTTP) exposing one
//                           `approve` tool, used as Claude Code's
//                           --permission-prompt-tool.
//
// Each agent session gets its own random token; requests for unknown tokens
// are rejected. The endpoint can only *ask* the user: decisions come from
// Conductor's approval panel, so a caller that learns a token gains nothing
// but the ability to raise approval requests for that session.
//
// Approvals can take minutes, so a tool call is answered over SSE with
// keepalive comments (Claude's HTTP client would otherwise time out), and
// the hook request is simply held open (curl has no default timeout).

type Json = Record<string, unknown>;

export interface BridgeHandlers {
  /** Antigravity PreToolUse hook payload → hook output JSON. */
  hook?: (payload: Json, signal: AbortSignal) => Promise<Json>;
  /** Claude Code permission prompt arguments → `{behavior, ...}`. */
  permissionPrompt?: (args: Json, signal: AbortSignal) => Promise<Json>;
}

export interface BridgeSession {
  /** `http://127.0.0.1:<port>/s/<token>`; append `/hook` or `/mcp`. */
  baseUrl: string;
  dispose(): void;
}

export const PERMISSION_TOOL = 'approve';
const MAX_BODY = 1_000_000;
const KEEPALIVE_MS = 15_000;
const MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const obj = (v: unknown): Json | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Json : null);

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

/** Aborts when the caller goes away before we answered. */
function clientGone(res: ServerResponse): AbortSignal {
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableFinished) controller.abort(); });
  return controller.signal;
}

export class ApprovalBridge {
  private server: Server | undefined;
  private listening: Promise<number> | undefined;
  private readonly sessions = new Map<string, BridgeHandlers>();

  async open(handlers: BridgeHandlers): Promise<BridgeSession> {
    const port = await this.listen();
    const token = randomBytes(24).toString('hex');
    this.sessions.set(token, handlers);
    return { baseUrl: `http://127.0.0.1:${port}/s/${token}`, dispose: () => { this.sessions.delete(token); } };
  }

  close(): void {
    this.sessions.clear();
    this.server?.close();
    this.server = undefined;
    this.listening = undefined;
  }

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
        if (address === null || typeof address === 'string') { reject(new Error('approval bridge did not bind')); return; }
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
    const match = /^\/s\/([0-9a-f]{48})\/(hook|mcp)$/.exec((req.url ?? '').split('?')[0] ?? '');
    const handlers = match !== null ? this.sessions.get(match[1]!) : undefined;
    if (match === null || handlers === undefined) { sendJson(res, 404, { error: 'unknown session' }); return; }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' });
      res.end();
      return;
    }
    let body: unknown;
    try { body = JSON.parse(await readBody(req)); } catch { sendJson(res, 400, { error: 'invalid JSON' }); return; }

    if (match[2] === 'hook') {
      if (handlers.hook === undefined) { sendJson(res, 404, { error: 'no hook' }); return; }
      const payload = obj(body) ?? {};
      sendJson(res, 200, await handlers.hook(payload, clientGone(res)));
      return;
    }
    await this.mcp(obj(body), handlers, res);
  }

  /** The smallest MCP server Claude Code needs: initialize, tools/list, tools/call. */
  private async mcp(message: Json | null, handlers: BridgeHandlers, res: ServerResponse): Promise<void> {
    if (message === null) { sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batch requests are not supported' } }); return; }
    const id = message['id'];
    const method = typeof message['method'] === 'string' ? message['method'] : undefined;
    if (id === undefined || id === null || method === undefined) { res.writeHead(202); res.end(); return; }
    const params = obj(message['params']) ?? {};
    const reply = (result: unknown): void => { sendJson(res, 200, { jsonrpc: '2.0', id, result }); };
    switch (method) {
      case 'initialize': {
        const requested = typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : '';
        reply({
          protocolVersion: MCP_VERSIONS.includes(requested) ? requested : MCP_VERSIONS[1],
          capabilities: { tools: {} },
          serverInfo: { name: 'conductor-approvals', version: '0.1.0' },
        });
        return;
      }
      case 'ping':
        reply({});
        return;
      case 'tools/list':
        reply({ tools: [{
          name: PERMISSION_TOOL,
          description: 'Asks the Conductor user whether a tool call may run.',
          inputSchema: {
            type: 'object',
            properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
            required: ['tool_name', 'input'],
          },
        }] });
        return;
      case 'tools/call': {
        if (params['name'] !== PERMISSION_TOOL || handlers.permissionPrompt === undefined) {
          reply({ content: [{ type: 'text', text: `Unknown tool ${String(params['name'])}` }], isError: true });
          return;
        }
        // Stream the answer so a slow human decision does not hit client timeouts.
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': waiting for the user\n\n');
        const keepalive = setInterval(() => { res.write(': keepalive\n\n'); }, KEEPALIVE_MS);
        try {
          const result = await handlers.permissionPrompt(obj(params['arguments']) ?? {}, clientGone(res));
          res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } })}\n\n`);
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

let shared: ApprovalBridge | undefined;

/** The process-wide bridge, started on first use. */
export function sharedApprovalBridge(): ApprovalBridge {
  shared ??= new ApprovalBridge();
  return shared;
}
