import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ApprovalBridge } from '@main/adapters/approval-bridge';
import { ClaudeCodeAdapter } from '@main/adapters/claude-code-adapter';
import type { CliEnvironment } from '@main/adapters/local-cli-adapter';
import type { AdapterStreamEvent } from '@shared/adapter';

const capability = {
  id: 'code.agent.run', title: 'Do the work',
  inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
  streaming: true, cancellable: true, resumable: false, requiredPermissions: [],
};

// `--output-format stream-json --verbose` prints one event per line: thinking,
// tool use/results as they happen, assistant text, then the result envelope.
const AGENT = String.raw`
const out = (event) => process.stdout.write(JSON.stringify(event) + '\n');
out({ type: 'system', subtype: 'init' });
out({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Inspecting the workspace.' }] } });
out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'npm test' } }] } });
out({ type: 'assistant', message: { content: [{ type: 'text', text: 'All done.' }] } });
out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', is_error: false, content: [{ type: 'text', text: '3 passed' }] }] } });
out({ type: 'result', subtype: 'success', is_error: false, result: 'All done.',
  usage: { input_tokens: 30, cache_creation_input_tokens: 10, cache_read_input_tokens: 60, output_tokens: 12 },
  modelUsage: { 'claude-test-model': {} } });
`;

const dirs: string[] = [];
const bridges: ApprovalBridge[] = [];
afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeEnvironment(script: string): CliEnvironment {
  return {
    pathEntries: ['/fake'],
    isExecutable: () => true,
    isPidAlive: () => true,
    spawn: (_executable, _args, options) => spawn(process.execPath, [script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: options?.cwd,
      env: { ...process.env as Record<string, string>, ...(options?.env ?? {}) },
    }) as ChildProcessWithoutNullStreams,
  };
}

describe('Claude Code stream-json activity', () => {
  it('streams thinking, tool activity and the reply without duplicating the final result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-claude-stream-'));
    dirs.push(dir);
    const script = join(dir, 'claude.mjs');
    writeFileSync(script, AGENT);
    const bridge = new ApprovalBridge();
    bridges.push(bridge);
    const adapter = new ClaudeCodeAdapter(
      { id: 'claude-code', name: 'Claude Code', command: 'fake-claude', capabilities: [capability] },
      async () => 'accept',
      fakeEnvironment(script),
      undefined,
      bridge,
    );

    const handle = await adapter.start({ objective: 'Run the tests', rootPath: dir, mode: 'trusted_automation', taskId: 't', stepId: 's' });
    const events: AdapterStreamEvent[] = [];
    for await (const event of adapter.stream(handle)) events.push(event);
    expect((await adapter.await(handle)).status).toBe('succeeded');

    const logs = events.filter((event) => event.kind === 'log').map((event) => event.data as {
      message?: string; kind?: string; detail?: string; key?: string; status?: string; source?: string;
    });
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'Inspecting the workspace.', kind: 'reasoning', source: 'Claude Code' }),
      expect.objectContaining({ message: 'Run npm test', kind: 'execute', detail: 'npm test', key: 'tool-1', status: 'running', source: 'Claude Code' }),
      expect.objectContaining({ key: 'tool-1', detail: 'npm test\n\n3 passed', status: 'completed', source: 'Claude Code' }),
    ]));
    const stdout = events.filter((event) => event.kind === 'stdout').map((event) => String(event.data));
    expect(stdout).toEqual(['All done.']);
  });
});
