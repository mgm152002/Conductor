import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { SandboxGateway, isLookOnly, toolGroup } from '@main/sandbox/sandbox-gateway';
import { readSandboxFile } from '@main/sandbox/sandbox-agents';
import { agentMemory, agentMemoryNamespace, SHARED_MEMORY_NAMESPACE } from '@main/sandbox/agent-memory';
import { SharedKnowledgeSync, chunkText } from '@main/sandbox/shared-knowledge';
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
  it('reports when the CLI has fetched the tool list, so a first prompt can wait for it', async () => {
    const { session } = open({ tools: ['browser'] });
    const opened = await session;
    let listed = false;
    void opened.listed.then(() => { listed = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listed).toBe(false);
    const cli = await connect(opened.url);
    await cli.listTools();
    await opened.listed;
    expect(listed).toBe(true);
    await cli.close();
  });

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

describe('handing a sandbox file back to the chat', () => {
  it('offers return_file only when the run can deliver, and never forwards it to the sandbox', async () => {
    const plain = await connect((await open().session).url);
    expect((await plain.listTools()).tools.map((tool) => tool.name)).not.toContain('return_file');

    const returned: Array<{ path: string; name?: string }> = [];
    const session = await gateway.open({
      agentName: 'Researcher', tools: ['files'], approval: 'all',
      sandbox: async () => ({ baseUrl: upstreamUrl, apiKey: API_KEY }),
      decide: async () => 'decline',
      returnFile: async (input) => { returned.push(input); return `${input.name ?? input.path} delivered`; },
    });
    const cli = await connect(session.url);
    expect((await cli.listTools()).tools.map((tool) => tool.name)).toContain('return_file');
    // No approval is asked even under approval: 'all' (decide would decline).
    const result = await cli.callTool({ name: 'return_file', arguments: { path: '/home/gem/out/report.pdf', name: 'Report.pdf' } });
    expect(result.isError).not.toBe(true);
    expect(text(result)).toBe('Report.pdf delivered');
    expect(returned).toEqual([{ path: '/home/gem/out/report.pdf', name: 'Report.pdf' }]);
    expect(calls).toEqual([]);
    const missing = await cli.callTool({ name: 'return_file', arguments: { path: '  ' } });
    expect(missing.isError).toBe(true);
  });

  it('reads the file from the download endpoint, or over the shell with a size check', async () => {
    const endpoint = { baseUrl: 'http://sandbox.test', apiKey: 'k' };
    const pdf = Buffer.from('%PDF-1.4 binary \x00\x01 bytes');
    const direct = (async (url: string | URL | Request) => {
      expect(String(url)).toBe('http://sandbox.test/v1/file/download?path=%2Fhome%2Fgem%2Fa%20b.pdf');
      return new Response(pdf, { headers: { 'content-type': 'application/pdf' } });
    }) as typeof fetch;
    expect((await readSandboxFile(endpoint, '/home/gem/a b.pdf', direct)).equals(pdf)).toBe(true);

    const commands: string[] = [];
    const shell = (output: string) => (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('/v1/file/download')) return new Response('{"detail":"Not Found"}', { status: 404, headers: { 'content-type': 'application/json' } });
      commands.push((JSON.parse(String(init?.body)) as { command: string }).command);
      return new Response(JSON.stringify({ success: true, data: { output } }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    expect((await readSandboxFile(endpoint, "/tmp/it's.pdf", shell(`${pdf.length}\n${pdf.toString('base64')}\n`))).equals(pdf)).toBe(true);
    expect(commands[0]).toContain(`'/tmp/it'\\''s.pdf'`);
    await expect(readSandboxFile(endpoint, '/tmp/x.pdf', shell(`${pdf.length + 5}\n${pdf.toString('base64')}`))).rejects.toThrow(/completely/);
    await expect(readSandboxFile(endpoint, '/tmp/none.pdf', shell(''))).rejects.toThrow(/No file was found/);
  });
});

describe('locking the folder agents share', () => {
  const S = '/home/gem/shared';
  const openAs = (id: string, name: string) => gateway.open({
    agentName: name, tools: ['files', 'shell'], approval: 'none',
    sandbox: async () => ({ baseUrl: upstreamUrl, apiKey: API_KEY }),
    decide: async () => 'accept',
    lockOwner: { id, name },
  });

  it('gives lock tools only to runs that can hold locks, and never forwards them', async () => {
    const plain = await connect((await open().session).url);
    expect((await plain.listTools()).tools.map((tool) => tool.name)).not.toContain('lock_shared');
    const cli = await connect((await openAs('task-a', 'Researcher')).url);
    expect((await cli.listTools()).tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['lock_shared', 'unlock_shared']));
    expect((await cli.callTool({ name: 'lock_shared', arguments: { path: `${S}/data` } })).isError).not.toBe(true);
    expect((await cli.callTool({ name: 'lock_shared', arguments: { path: '/home/gem/workspace/x' } })).isError).toBe(true);
    expect((await cli.callTool({ name: 'lock_shared', arguments: { path: S } })).isError).toBe(true);
    expect((await cli.callTool({ name: 'lock_shared', arguments: { path: `${S}/../workspace/x` } })).isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it('in a group sandbox, treats the workspace as the shared folder, so both paths lock the same files', async () => {
    const group = (id: string, name: string) => gateway.open({
      agentName: name, tools: ['files', 'shell'], approval: 'none',
      sandbox: async () => ({ baseUrl: upstreamUrl, apiKey: API_KEY }),
      decide: async () => 'accept', lockOwner: { id, name }, workspaceIsShared: true,
    });
    const a = await connect((await group('task-a', 'Researcher')).url);
    const b = await connect((await group('task-b', 'Writer')).url);
    expect((await a.callTool({ name: 'lock_shared', arguments: { path: '/home/gem/workspace/report' } })).isError).not.toBe(true);
    expect(gateway.locks.list().map((lock) => lock.path)).toEqual([`${S}/report`]);
    for (const call of [
      { name: 'file_write', arguments: { path: `${S}/report/a.md` } },
      { name: 'file_write', arguments: { path: '/home/gem/workspace/report/a.md' } },
      { name: 'terminal_execute', arguments: { command: 'echo x >> ~/workspace/report/a.md' } },
      { name: 'lock_shared', arguments: { path: '$HOME/workspace/report' } },
    ]) expect((await b.callTool(call)).isError).toBe(true);
    // A similarly named folder is a different path.
    expect((await b.callTool({ name: 'file_write', arguments: { path: '/home/gem/workspace-old/x' } })).isError).not.toBe(true);
    expect((await a.callTool({ name: 'unlock_shared', arguments: { path: `${S}/report` } })).isError).not.toBe(true);
    expect((await b.callTool({ name: 'file_write', arguments: { path: '/home/gem/workspace/report/a.md' } })).isError).not.toBe(true);
  });

  it('turns another agent away from a locked file or folder until it is unlocked', async () => {
    const a = await connect((await openAs('task-a', 'Researcher')).url);
    const b = await connect((await openAs('task-b', 'Writer')).url);
    await a.callTool({ name: 'lock_shared', arguments: { path: `${S}/data` } });

    const taken = await b.callTool({ name: 'lock_shared', arguments: { path: `${S}/data/rows.csv` } });
    expect(taken.isError).toBe(true);
    expect(text(taken)).toContain('locked by Researcher');
    // Writes through a file tool, a command naming the path, and a command on a parent folder.
    for (const call of [
      { name: 'file_write', arguments: { path: `${S}/data/rows.csv` } },
      { name: 'terminal_execute', arguments: { command: `echo x >> ${S}/data/rows.csv` } },
      { name: 'terminal_execute', arguments: { command: 'rm -rf ~/shared/*' } },
      { name: 'terminal_execute', arguments: { command: `mv "${S}/data" /tmp/` } },
    ]) {
      const refused = await b.callTool(call);
      expect(refused.isError).toBe(true);
      expect(text(refused)).toContain('locked by Researcher');
    }
    expect(calls).toEqual([]);

    // Reading is never blocked, nor is the rest of the folder or the holder itself.
    expect((await b.callTool({ name: 'file_read', arguments: { path: `${S}/data/rows.csv` } })).isError).not.toBe(true);
    expect((await b.callTool({ name: 'file_write', arguments: { path: `${S}/other.md` } })).isError).not.toBe(true);
    expect((await b.callTool({ name: 'terminal_execute', arguments: { command: `ls ${S}/database` } })).isError).not.toBe(true);
    expect((await a.callTool({ name: 'terminal_execute', arguments: { command: `echo x >> ${S}/data/rows.csv` } })).isError).not.toBe(true);

    expect((await b.callTool({ name: 'unlock_shared', arguments: { path: `${S}/data` } })).isError).toBe(true);
    expect((await a.callTool({ name: 'unlock_shared', arguments: { path: `${S}/data` } })).isError).not.toBe(true);
    expect((await b.callTool({ name: 'file_write', arguments: { path: `${S}/data/rows.csv` } })).isError).not.toBe(true);
  });

  it('locks a shared file for whoever writes it with a file tool, and frees it when their run ends', async () => {
    const first = await openAs('task-a', 'Researcher');
    const a = await connect(first.url);
    const b = await connect((await openAs('task-b', 'Writer')).url);
    await a.callTool({ name: 'file_write', arguments: { path: `${S}/notes.md` } });
    expect(gateway.locks.list().map((lock) => [lock.path, lock.owner.name])).toEqual([[`${S}/notes.md`, 'Researcher']]);
    expect((await b.callTool({ name: 'file_write', arguments: { path: `${S}/notes.md` } })).isError).toBe(true);
    // Files outside the shared folder are nobody's business.
    await a.callTool({ name: 'file_write', arguments: { path: '/home/gem/workspace/notes.md' } });
    expect(gateway.locks.list()).toHaveLength(1);

    first.dispose();
    expect(gateway.locks.list()).toEqual([]);
    expect((await b.callTool({ name: 'file_write', arguments: { path: `${S}/notes.md` } })).isError).not.toBe(true);
  });
});

describe('SandboxGateway tools/list while the sandbox starts', () => {
  const never = (): Promise<{ baseUrl: string; apiKey: string }> => new Promise(() => undefined);
  const dir = mkdtempSync(join(tmpdir(), 'gateway-cache-'));
  afterEach(() => { gateway.close(); });

  it('answers from the last list the sandbox gave, without waiting for it to start', async () => {
    const cache = join(dir, 'tools.json');
    const first = new SandboxGateway(cache, 'image-1');
    const warm = await first.open({ agentName: 'Researcher', tools: ['browser', 'files'], approval: 'none', sandbox: async () => ({ baseUrl: upstreamUrl, apiKey: API_KEY }), decide: async () => 'accept' });
    expect(await (await connect(warm.url)).listTools().then((r) => r.tools.length)).toBeGreaterThan(0);
    warm.dispose(); first.close();

    // A new app run with a sandbox that is still starting.
    const second = new SandboxGateway(cache, 'image-1');
    const cold = await second.open({ agentName: 'Researcher', tools: ['browser'], approval: 'none', sandbox: never, decide: async () => 'accept' });
    const started = Date.now();
    const names = (await (await connect(cold.url)).listTools()).tools.map((tool) => tool.name);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(names).toContain('browser_navigate');
    expect(names).not.toContain('terminal_execute');
    cold.dispose(); second.close();

    // A different sandbox image must not be shown the old list.
    const other = new SandboxGateway(cache, 'image-2');
    const fresh = await other.open({ agentName: 'Researcher', tools: ['browser'], approval: 'none', sandbox: never, decide: async () => 'accept' });
    const stale = (await (await connect(fresh.url)).listTools()).tools.map((tool) => tool.name);
    expect(stale).toContain('browser_get_markdown'); // the list shipped with the app, not the saved one
    fresh.dispose(); other.close();
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);
});

describe("an agent's private memory", () => {
  /** A stand-in for Mem0 that keeps notes per user_id, like the real service. */
  function fakeMem0() {
    const notes: Array<{ id: string; memory: string; user_id: string; metadata?: Record<string, unknown> }> = [];
    let seq = 0;
    return {
      notes,
      addNote: async (user: string, memory: string, metadata: Record<string, unknown> = {}) => { const note = { id: `m${++seq}`, memory, user_id: user, metadata }; notes.push(note); return note; },
      searchNotes: async (user: string, query: string) => notes.filter((n) => n.user_id === user && n.memory.includes(query)),
      listNotes: async (user: string) => notes.filter((n) => n.user_id === user),
      get: async (id: string) => notes.find((n) => n.id === id)!,
      delete: async (id: string) => { notes.splice(notes.findIndex((n) => n.id === id), 1); },
    };
  }

  it('saves, finds and forgets notes in a namespace of its own, never another agent\'s', async () => {
    const mem0 = fakeMem0();
    const a = agentMemory(mem0, 'agent-a');
    const b = agentMemory(mem0, 'agent-b');
    await a.save('The user prefers tables');
    await b.save('Deploys go out on Fridays');
    expect(mem0.notes.map((n) => n.user_id)).toEqual([agentMemoryNamespace('agent-a'), agentMemoryNamespace('agent-b')]);
    expect(agentMemoryNamespace('agent-a')).not.toBe('conductor');
    expect(await a.search('prefers')).toContain('tables');
    expect(await a.search('Fridays')).toBe('Nothing saved matches.');
    expect(await a.search('')).not.toContain('Fridays');
    await expect(a.forget('m2')).rejects.toThrow(/not yours/);
    expect(await a.forget('m1')).toContain('Forgot');
    expect(mem0.notes).toHaveLength(1);
    await expect(a.save('   ')).rejects.toThrow();
  });

  it('offers the memory tools only when configured, and never forwards them to the sandbox', async () => {
    const plain = await connect((await open().session).url);
    expect((await plain.listTools()).tools.map((tool) => tool.name)).not.toContain('memory_save');

    const mem0 = fakeMem0();
    const session = await gateway.open({
      agentName: 'Researcher', tools: ['files'], approval: 'all',
      sandbox: async () => ({ baseUrl: upstreamUrl, apiKey: API_KEY }),
      decide: async () => 'decline',
      memory: agentMemory(mem0, 'agent-a'),
    });
    const cli = await connect(session.url);
    expect((await cli.listTools()).tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['memory_save', 'memory_search', 'memory_forget']));
    // No approval (decide would decline) and nothing reaches the sandbox.
    expect((await cli.callTool({ name: 'memory_save', arguments: { text: 'Likes dark mode' } })).isError).not.toBe(true);
    expect(text(await cli.callTool({ name: 'memory_search', arguments: { query: 'dark' } }))).toContain('Likes dark mode');
    expect((await cli.callTool({ name: 'memory_forget', arguments: { id: 'm1' } })).isError).not.toBe(true);
    expect(calls).toEqual([]);
  });

  it('offers the email tools only when connected, handled outside the sandbox without approval', async () => {
    const plain = await connect((await open().session).url);
    expect((await plain.listTools()).tools.map((tool) => tool.name)).not.toContain('email_send');
    const sent: string[] = [];
    const session = await gateway.open({
      agentName: 'Mailer', tools: ['files'], approval: 'all',
      sandbox: async () => ({ baseUrl: upstreamUrl, apiKey: API_KEY }),
      decide: async () => 'decline',
      mail: { send: async (subject, body) => { sent.push(`${subject}|${body}`); return 'Sent.'; }, inbox: async () => 'm1 · subject', read: async () => 'body' },
    });
    const cli = await connect(session.url);
    expect((await cli.listTools()).tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['email_send', 'email_inbox', 'email_read']));
    expect(text(await cli.callTool({ name: 'email_send', arguments: { subject: 'Jobs', body: 'one' } }))).toBe('Sent.');
    expect(sent).toEqual(['Jobs|one']);
    expect(text(await cli.callTool({ name: 'email_inbox', arguments: {} }))).toContain('m1');
    expect(calls).toEqual([]);
  });

  it('sends email and saves memory even when the sandbox cannot start', async () => {
    const sent: string[] = [];
    const session = await gateway.open({
      agentName: 'Mailer', tools: ['files'], approval: 'none',
      sandbox: async () => { throw new Error('Docker has too little memory'); },
      decide: async () => 'accept',
      memory: agentMemory(fakeMem0(), 'agent-a'),
      mail: { send: async (subject) => { sent.push(subject); return 'Sent.'; }, inbox: async () => '', read: async () => '' },
    });
    const cli = await connect(session.url);
    expect(text(await cli.callTool({ name: 'email_send', arguments: { subject: 'Jobs', body: 'x' } }))).toBe('Sent.');
    expect((await cli.callTool({ name: 'memory_save', arguments: { text: 'note' } })).isError).not.toBe(true);
    expect(sent).toEqual(['Jobs']);
  });

  it('tells the agent when Mem0 is down instead of failing the run', async () => {
    const session = await gateway.open({
      agentName: 'Researcher', tools: ['files'], approval: 'none',
      sandbox: async () => ({ baseUrl: upstreamUrl, apiKey: API_KEY }),
      decide: async () => 'accept',
      memory: { save: async () => { throw new Error('Mem0 is unavailable'); }, search: async () => '', forget: async () => '' },
    });
    const cli = await connect(session.url);
    const result = await cli.callTool({ name: 'memory_save', arguments: { text: 'x' } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('unavailable');
  });

  it('shares knowledge between agents through its own namespace', async () => {
    const mem0 = fakeMem0();
    const a = agentMemory(mem0, 'agent-a');
    const b = agentMemory(mem0, 'agent-b');
    await a.save('Staging is at example.test', 'shared');
    await a.save('My private hunch', 'private');
    expect(mem0.notes[0]!.user_id).toBe(SHARED_MEMORY_NAMESPACE);
    expect(await b.search('Staging')).toContain('(shared) Staging is at example.test');
    expect(await b.search('hunch')).toBe('Nothing saved matches.');
    expect(await b.search('', 'private')).toBe('Nothing saved matches.');
    expect(await b.forget('m1')).toContain('Forgot');
  });

  it('copies the shared volume into the shared namespace, only when a file changed or left', async () => {
    const mem0 = fakeMem0();
    let files = [{ path: 'notes/a.md', content: 'Alpha facts' }, { path: 'b.txt', content: 'Beta' }];
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-'));
    try {
      const sync = new SharedKnowledgeSync({ mem0, sources: async () => [{ namespace: SHARED_MEMORY_NAMESPACE, files }], stateFile: join(dir, 'state.json') });
      await sync.sync();
      expect(mem0.notes.map((n) => n.user_id)).toEqual([SHARED_MEMORY_NAMESPACE, SHARED_MEMORY_NAMESPACE]);
      expect(mem0.notes[0]!.memory).toContain('notes/a.md');
      await sync.sync();
      expect(mem0.notes).toHaveLength(2);
      files = [{ path: 'notes/a.md', content: 'Alpha facts, updated' }];
      await sync.sync();
      expect(mem0.notes.map((n) => n.memory).join('|')).toContain('updated');
      expect(mem0.notes.some((n) => n.memory.includes('b.txt'))).toBe(false);
      expect(mem0.notes).toHaveLength(1);
      // The copied files are refreshed from their source, not removed by agents.
      await expect(agentMemory(mem0, 'agent-a').forget(mem0.notes[0]!.id)).rejects.toThrow(/not yours/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('splits long files into bounded pieces', () => {
    const pieces = chunkText(`${'x'.repeat(4_000)}\n\nshort`);
    expect(pieces.length).toBeGreaterThan(2);
    expect(pieces.every((piece) => piece.length <= 1_500)).toBe(true);
  });
});
