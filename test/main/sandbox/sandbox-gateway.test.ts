import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { SandboxGateway, isLookOnly, toolGroup } from '@main/sandbox/sandbox-gateway';
import type { GateRequest, ToolApprovalDecision } from '@main/adapters/tool-gate';

// The gateway sits between an agent CLI and the AIO Sandbox's MCP endpoint.
// A real MCP server stands in for the sandbox here, so the test covers the
// actual protocol round trip: tool filtering, the approval gate, and
// forwarding — with no Docker.

const API_KEY = 'test-key';
let upstream: Server;
let upstreamUrl: string;
let calls: string[];
let seenKeys: Array<string | undefined>;

async function startUpstream(): Promise<void> {
  upstream = createServer((req, res) => {
    seenKeys.push(req.headers['x-aio-api-key'] as string | undefined);
    // Stateless: a fresh server + transport per request.
    const server = new McpServer({ name: 'fake-aio-sandbox', version: '1.0.0' });
    const tool = (name: string): void => {
      server.registerTool(name, { description: name, inputSchema: { url: z.string().optional(), command: z.string().optional(), path: z.string().optional() } }, async (args) => {
        calls.push(name);
        return { content: [{ type: 'text', text: `${name} ok ${JSON.stringify(args)}` }] };
      });
    };
    ['browser_navigate', 'browser_click', 'browser_screenshot', 'terminal_execute', 'file_read', 'file_write', 'markitdown_convert', 'mystery_tool'].forEach(tool);
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    void server.connect(transport).then(() => transport.handleRequest(req, res));
  });
  await new Promise<void>((resolve) => { upstream.listen(0, '127.0.0.1', resolve); });
  const address = upstream.address();
  upstreamUrl = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
}

async function connect(url: string): Promise<Client> {
  const client = new Client({ name: 'test-cli', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

let gateway: SandboxGateway;
beforeEach(async () => {
  calls = [];
  seenKeys = [];
  await startUpstream();
  gateway = new SandboxGateway();
});
afterEach(async () => {
  gateway.close();
  await new Promise<void>((resolve) => { upstream.close(() => { resolve(); }); });
});

function open(options: { tools?: Array<'browser' | 'shell' | 'files' | 'code' | 'documents'>; approval?: 'risky' | 'all' | 'none'; decision?: ToolApprovalDecision } = {}) {
  const asked: GateRequest[] = [];
  const session = gateway.open({
    agentName: 'Researcher',
    tools: options.tools ?? ['browser', 'files'],
    approval: options.approval ?? 'risky',
    sandbox: async () => ({ baseUrl: upstreamUrl, apiKey: API_KEY }),
    decide: async (request) => { asked.push(request); return options.decision ?? 'accept'; },
  });
  return { session, asked };
}

const text = (result: unknown): string => ((result as { content: Array<{ text: string }> }).content[0]?.text ?? '');

describe('toolGroup', () => {
  it('sorts sandbox tools into families', () => {
    expect(toolGroup('browser_navigate')).toBe('browser');
    expect(toolGroup('terminal_execute')).toBe('shell');
    expect(toolGroup('sandbox_execute_bash')).toBe('shell');
    expect(toolGroup('file_write')).toBe('files');
    expect(toolGroup('markitdown_convert')).toBe('documents');
    expect(toolGroup('jupyter_execute')).toBe('code');
    expect(toolGroup('sandbox_str_replace_editor')).toBe('files');
    expect(toolGroup('sandbox_file_operations')).toBe('files');
    expect(toolGroup('sandbox_execute_code')).toBe('code');
    expect(toolGroup('sandbox_convert_to_markdown')).toBe('documents');
    expect(toolGroup('mystery_tool')).toBeUndefined();
  });
});

describe('isLookOnly', () => {
  it('decides file calls from their action, as the real sandbox tools take it', () => {
    expect(isLookOnly('sandbox_file_operations', { action: 'read', path: '/a' })).toBe(true);
    expect(isLookOnly('sandbox_file_operations', { action: 'list', path: '/' })).toBe(true);
    expect(isLookOnly('sandbox_file_operations', { action: 'write', path: '/a' })).toBe(false);
    expect(isLookOnly('sandbox_str_replace_editor', { command: 'view', path: '/a' })).toBe(true);
    expect(isLookOnly('sandbox_str_replace_editor', { command: 'str_replace', path: '/a' })).toBe(false);
  });
  it('lets browsing and reading pages through but not acting on them', () => {
    for (const tool of ['browser_navigate', 'browser_get_text', 'browser_screenshot', 'browser_new_tab', 'browser_tab_list', 'browser_scroll']) expect(isLookOnly(tool)).toBe(true);
    for (const tool of ['browser_click', 'browser_form_input_fill', 'browser_press_key', 'browser_evaluate', 'browser_gui_execute_action']) expect(isLookOnly(tool)).toBe(false);
    expect(isLookOnly('sandbox_execute_bash', { cmd: 'ls' })).toBe(false);
    expect(isLookOnly('sandbox_get_context')).toBe(true);
  });
});

describe('SandboxGateway', () => {
  it('offers only the tool families the agent was given, and sends the sandbox key upstream', async () => {
    const { session } = open({ tools: ['browser', 'files'] });
    const cli = await connect((await session).url);
    const names = (await cli.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual(['browser_click', 'browser_navigate', 'browser_screenshot', 'file_read', 'file_write']);
    expect(seenKeys.every((key) => key === API_KEY)).toBe(true);
    await cli.close();
  });

  it('runs look-only calls without asking and gates risky ones', async () => {
    const { session, asked } = open({ tools: ['browser', 'files'] });
    const cli = await connect((await session).url);
    expect(text(await cli.callTool({ name: 'browser_navigate', arguments: { url: 'https://example.com' } }))).toContain('browser_navigate ok');
    expect(text(await cli.callTool({ name: 'file_read', arguments: { path: '/tmp/a' } }))).toContain('file_read ok');
    expect(asked).toEqual([]);
    expect(text(await cli.callTool({ name: 'file_write', arguments: { path: '/tmp/a' } }))).toContain('file_write ok');
    expect(asked).toHaveLength(1);
    expect(asked[0]!.kind).toBe('file_change');
    expect(asked[0]!.summary).toContain('Researcher');
    expect(asked[0]!.detail).toBe('/tmp/a');
    expect(calls).toEqual(['browser_navigate', 'file_read', 'file_write']);
    await cli.close();
  });

  it('does not forward a declined call and tells the agent not to retry', async () => {
    const { session, asked } = open({ tools: ['shell'], decision: 'decline' });
    const cli = await connect((await session).url);
    const result = await cli.callTool({ name: 'terminal_execute', arguments: { command: 'rm -rf /work' } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/declined/);
    expect(asked[0]!.kind).toBe('command');
    expect(asked[0]!.detail).toBe('rm -rf /work');
    expect(calls).toEqual([]);
    await cli.close();
  });

  it('asks for everything with the "all" policy and nothing with "none"', async () => {
    const all = open({ tools: ['browser'], approval: 'all' });
    let cli = await connect((await all.session).url);
    await cli.callTool({ name: 'browser_screenshot', arguments: {} });
    expect(all.asked).toHaveLength(1);
    await cli.close();
    const none = open({ tools: ['shell'], approval: 'none' });
    cli = await connect((await none.session).url);
    await cli.callTool({ name: 'terminal_execute', arguments: { command: 'ls' } });
    expect(none.asked).toHaveLength(0);
    expect(calls).toContain('terminal_execute');
    await cli.close();
  });

  it('refuses tools outside the agent’s families even when called by name', async () => {
    const { session } = open({ tools: ['browser'] });
    const cli = await connect((await session).url);
    const result = await cli.callTool({ name: 'terminal_execute', arguments: { command: 'id' } });
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
    await cli.close();
  });

  it('rejects unknown sessions', async () => {
    const { session } = open();
    const url = new URL((await session).url);
    const forged = `${url.origin}/g/${'0'.repeat(48)}/mcp`;
    const response = await fetch(forged, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(404);
  });
});
