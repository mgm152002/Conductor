import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AcpAgentAdapter, type AcpAgentSpec } from '@main/adapters/acp-agent-adapter';
import type { CliEnvironment } from '@main/adapters/local-cli-adapter';
import type { AdapterStreamEvent } from '@shared/adapter';

const capability = {
  id: 'objective.fulfill.opencode', title: 'Do the work',
  inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
  streaming: true, cancellable: true, resumable: false, requiredPermissions: [],
};

// A stand-in ACP agent. The first prompt asks to run a shell command and, like
// OpenCode 2.x, ends the turn with "cancelled" when the request is rejected.
// It answers a second prompt normally, which is what the adapter's
// continuation is for.
const AGENT = String.raw`
let buffer = '';
let promptId;
let prompts = 0;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const reply = (id, result) => send({ id, result });
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    const message = JSON.parse(line);
    if (message.method === 'initialize') reply(message.id, { protocolVersion: 1, agentCapabilities: { promptCapabilities: { embeddedContext: true, image: true } } });
    else if (message.method === 'session/new') reply(message.id, { sessionId: 'fake-session' });
    else if (message.method === 'session/prompt') {
      const text = message.params.prompt.find((part) => part.type === 'text')?.text ?? '';
      const body = text.includes('\n') ? JSON.parse(text.slice(text.indexOf('\n') + 1)) : {};
      if (body.objective === 'inspect attachments') {
        const image = message.params.prompt.find((part) => part.type === 'image');
        const links = message.params.prompt.filter((part) => part.type === 'resource_link');
        send({ method: 'session/update', params: { sessionId: 'fake-session', update: {
          sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify({
            promptTypes: message.params.prompt.map((part) => part.type), image, links,
            attachments: body.attachments, attachmentContents: body.attachmentContents,
          }) },
        } } });
        reply(message.id, { stopReason: 'end_turn' });
        continue;
      }
      if (body.objective === 'show activity') {
        send({ method: 'session/update', params: { sessionId: 'fake-session', update: {
          sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Inspecting the workspace.' },
        } } });
        send({ method: 'session/update', params: { sessionId: 'fake-session', update: {
          sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Bash', kind: 'execute', status: 'pending',
          rawInput: { command: 'npm test' },
        } } });
        send({ method: 'session/update', params: { sessionId: 'fake-session', update: {
          sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed',
        } } });
        send({ method: 'session/update', params: { sessionId: 'fake-session', update: {
          sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' },
        } } });
        reply(message.id, { stopReason: 'end_turn' });
        continue;
      }
      prompts += 1;
      if (prompts === 1) {
        promptId = message.id;
        send({ id: 900, method: 'session/request_permission', params: {
          sessionId: 'fake-session',
          toolCall: { kind: 'execute', title: 'ls -la', rawInput: { command: 'ls -la' } },
          options: [{ optionId: 'allow-once', kind: 'allow_once' }, { optionId: 'reject-once', kind: 'reject_once' }],
        } });
      } else {
        send({ method: 'session/update', params: { sessionId: 'fake-session', update: {
          sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'CONTINUED' },
        } } });
        reply(message.id, { stopReason: 'end_turn' });
      }
    } else if (message.id === 900) {
      reply(promptId, { stopReason: 'cancelled' });
    }
  }
});
`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeEnvironment(): CliEnvironment {
  return {
    pathEntries: ['/fake'],
    isExecutable: () => true,
    isPidAlive: () => true,
    spawn: (_executable, args, options) => spawn(process.execPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: options?.cwd,
      env: { ...process.env as Record<string, string>, ...(options?.env ?? {}) },
    }) as ChildProcessWithoutNullStreams,
  };
}

describe('ACP adapter decline handling', () => {
  it('sends images and file resources natively while retaining extracted document content', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-acp-'));
    dirs.push(dir);
    const script = join(dir, 'agent.mjs');
    const imagePath = join(dir, 'chart.png');
    const pdfPath = join(dir, 'JD.pdf');
    writeFileSync(script, AGENT);
    writeFileSync(imagePath, 'image bytes');
    writeFileSync(pdfPath, 'pdf bytes');
    const spec: AcpAgentSpec = { args: [script], modelKey: 'opencode', loginHint: 'n/a' };
    const adapter = new AcpAgentAdapter(
      { id: 'opencode', name: 'OpenCode', command: 'fake-acp', capabilities: [capability] },
      spec,
      async () => 'decline',
      fakeEnvironment(),
    );

    const common = { sizeBytes: 11, sha256: 'c'.repeat(64), createdAt: '2026-10-26T00:00:00Z' };
    const handle = await adapter.start({
      objective: 'inspect attachments', rootPath: dir, mode: 'read_only',
      attachments: [
        { ...common, id: 'image-1', name: 'chart.png', kind: 'image', mimeType: 'image/png', path: imagePath },
        { ...common, id: 'pdf-1', name: 'JD.pdf', kind: 'pdf', mimeType: 'application/pdf', path: pdfPath, extractedText: 'Graduate Assistant role.' },
      ],
    });
    const events: AdapterStreamEvent[] = [];
    for await (const event of adapter.stream(handle)) events.push(event);
    expect((await adapter.await(handle)).status).toBe('succeeded');

    const reply = JSON.parse(String(events.find((event) => event.kind === 'stdout')?.data)) as {
      promptTypes: string[];
      image: { mimeType: string; data: string };
      links: { uri: string; name: string; mimeType: string; size: number }[];
      attachments: { path: string }[];
      attachmentContents: { name: string; text: string }[];
    };
    expect(reply.promptTypes).toEqual(['text', 'image', 'resource_link']);
    expect(reply.image).toEqual({ type: 'image', mimeType: 'image/png', data: Buffer.from('image bytes').toString('base64') });
    expect(reply.links).toEqual([{ type: 'resource_link', uri: pathToFileURL(pdfPath).href, name: 'JD.pdf', mimeType: 'application/pdf', size: 11 }]);
    expect(reply.attachments.map((attachment) => attachment.path)).toEqual([imagePath, pdfPath]);
    expect(reply.attachmentContents).toEqual([{ name: 'JD.pdf', kind: 'pdf', text: 'Graduate Assistant role.' }]);
  });

  it('continues the turn after a read-only tool is declined instead of reporting cancellation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-acp-'));
    dirs.push(dir);
    const script = join(dir, 'agent.mjs');
    writeFileSync(script, AGENT);
    const spec: AcpAgentSpec = { args: [script], modelKey: 'opencode', loginHint: 'n/a' };
    const adapter = new AcpAgentAdapter(
      { id: 'opencode', name: 'OpenCode', command: 'fake-acp', capabilities: [capability] },
      spec,
      async () => 'decline',
      fakeEnvironment(),
    );

    const handle = await adapter.start({ objective: 'Plan something', rootPath: dir, mode: 'read_only', taskId: 't', stepId: 's' });
    const events: AdapterStreamEvent[] = [];
    for await (const event of adapter.stream(handle)) events.push(event);
    const result = await adapter.await(handle);

    expect(result.status).toBe('succeeded');
    const text = events.filter((e) => e.kind === 'stdout').map((e) => String(e.data)).join('\n');
    expect(text).toContain('CONTINUED');
    const logs = events.filter((e) => e.kind === 'log').map((e) => e.data as { message?: string });
    expect(logs.some((l) => l.message?.includes('stopped after a tool was declined'))).toBe(true);
  });

  it('emits reasoning and keyed tool activity so the thread shows what the agent is doing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-acp-'));
    dirs.push(dir);
    const script = join(dir, 'agent.mjs');
    writeFileSync(script, AGENT);
    const spec: AcpAgentSpec = { args: [script], modelKey: 'opencode', loginHint: 'n/a' };
    const adapter = new AcpAgentAdapter(
      { id: 'opencode', name: 'OpenCode', command: 'fake-acp', capabilities: [capability] },
      spec,
      async () => 'accept',
      fakeEnvironment(),
    );

    const handle = await adapter.start({ objective: 'show activity', rootPath: dir, mode: 'read_only', taskId: 't', stepId: 's' });
    const events: AdapterStreamEvent[] = [];
    for await (const event of adapter.stream(handle)) events.push(event);
    expect((await adapter.await(handle)).status).toBe('succeeded');

    const logs = events.filter((e) => e.kind === 'log').map((e) => e.data as {
      message?: string; kind?: string; detail?: string; key?: string; status?: string; source?: string;
    });
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'Inspecting the workspace.', kind: 'reasoning', source: 'OpenCode' }),
      expect.objectContaining({ message: 'Bash', kind: 'execute', detail: 'npm test', key: 'call-1', status: 'running', source: 'OpenCode' }),
      expect.objectContaining({ key: 'call-1', status: 'completed', source: 'OpenCode' }),
    ]));
    expect(events.filter((e) => e.kind === 'stdout').map((e) => String(e.data))).toContain('Done.');
  });
});
