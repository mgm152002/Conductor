import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    if (message.method === 'initialize') reply(message.id, { protocolVersion: 1, agentCapabilities: {} });
    else if (message.method === 'session/new') reply(message.id, { sessionId: 'fake-session' });
    else if (message.method === 'session/prompt') {
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
});
