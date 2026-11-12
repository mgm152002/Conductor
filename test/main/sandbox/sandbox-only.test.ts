import { describe, expect, it } from 'vitest';
import { ToolGate, type GateRequest } from '@main/adapters/tool-gate';
import { ClaudeCodeAdapter } from '@main/adapters/claude-code-adapter';
import { ACP_AGENTS } from '@main/adapters/acp-agent-adapter';

// A sandbox agent's work must happen in its sandbox. Its CLI's own shell,
// file edits and web tools are switched off (Claude Code, OpenCode) or
// declined at the gate (every CLI), even when the user turned on auto-approve.

const command: GateRequest = { kind: 'command', summary: 'Run curl', detail: 'curl -s https://example.com' };
const edit: GateRequest = { kind: 'file_change', summary: 'Edit a file' };
const read: GateRequest = { kind: 'permissions', readOnly: true, summary: 'Read a file' };
const approveEverything = async (): Promise<'accept'> => 'accept';

describe('sandbox-only tool gate', () => {
  it('declines local commands and file changes even with auto-approve or trusted automation', async () => {
    for (const mode of ['assisted_execution', 'trusted_automation'] as const) {
      const gate = new ToolGate(mode, approveEverything, { taskId: 't', stepId: 's' }, { sandboxOnly: true, autoApprove: () => true });
      expect(await gate.decide(command)).toBe('decline');
      expect(await gate.decide(edit)).toBe('decline');
      expect(await gate.decide(read)).toBe('accept');
    }
  });

  it('is unchanged for ordinary runs', async () => {
    const gate = new ToolGate('trusted_automation', approveEverything, { taskId: 't', stepId: 's' }, { autoApprove: () => true });
    expect(await gate.decide(command)).toBe('accept');
  });
});

describe('sandbox-only CLI launches', () => {
  const input = {
    objective: 'Find hours', rootPath: '/tmp/agent-space', mode: 'assisted_execution' as const, taskId: 't', stepId: 's',
    mcpServers: [{ key: 'sandbox', url: 'http://127.0.0.1:1/g/token/mcp' }],
  };

  it('starts Claude Code with no Bash, web or edit tools, and the sandbox pre-allowed', async () => {
    const adapter = new ClaudeCodeAdapter({ id: 'claude-code', name: 'Claude Code', command: 'claude' } as never, approveEverything);
    const launch = await (adapter as unknown as { prepare(live: unknown): Promise<{ args: string[] }> }).prepare({
      data: { ...input, sandboxOnly: true }, gate: {}, events: { push: () => {} }, cleanup: [],
    });
    const args = launch.args;
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Glob,Grep');
    expect(args).toContain('mcp__sandbox__*');
    // A normal run keeps Claude's built-in tools.
    const normal = await (adapter as unknown as { prepare(live: unknown): Promise<{ args: string[] }> }).prepare({
      data: { ...input }, gate: {}, events: { push: () => {} }, cleanup: [],
    });
    expect(normal.args).not.toContain('--tools');
  });

  it('gives OpenCode a config that denies its shell, edits and web tools', () => {
    const env = ACP_AGENTS['opencode']!.env!('trusted_automation', true);
    const permission = (JSON.parse(env!['OPENCODE_CONFIG_CONTENT']!) as { permission: Record<string, unknown> }).permission;
    for (const tool of ['bash', 'edit', 'write', 'webfetch', 'websearch']) expect(permission[tool]).toBe('deny');
    expect(ACP_AGENTS['opencode']!.env!('trusted_automation', false)).toBeUndefined();
  });
});
