import { describe, expect, it } from 'vitest';
import { ToolGate, type GateRequest } from '@main/adapters/tool-gate';
import { ClaudeCodeAdapter, claudeGateRequest } from '@main/adapters/claude-code-adapter';
import { classifyAgyTool } from '@main/adapters/antigravity-adapter';
import { acpGateRequest } from '@main/adapters/acp-agent-adapter';
import { codexThreadConfig } from '@main/adapters/codex-app-server-adapter';

// Casual chat is read-only, but it may look things up on the web with each
// CLI's own web tools (Claude Code WebSearch/WebFetch, Codex web search,
// Antigravity search_web/read_url_content, OpenCode/Kiro web fetch/search).
// Nothing else that a read-only run declines is let through.

const ids = { taskId: 't', stepId: 's' };
const never = async (): Promise<'decline'> => 'decline';
const webSearch: GateRequest = { kind: 'permissions', web: true, summary: 'search the web' };
const command: GateRequest = { kind: 'command', summary: 'Run curl', detail: 'curl https://example.com' };
const otherTool: GateRequest = { kind: 'permissions', summary: 'use some tool' };

describe('read-only gate with web access', () => {
  it('accepts web lookups without asking, and nothing else', async () => {
    const gate = new ToolGate('read_only', never, ids, { allowWeb: true });
    expect(await gate.decide(webSearch)).toBe('accept');
    expect(await gate.decide(command)).toBe('decline');
    expect(await gate.decide(otherTool)).toBe('decline');
    expect(await gate.decide({ kind: 'file_change', summary: 'edit' })).toBe('decline');
  });

  it('still declines web lookups in read-only runs without web access', async () => {
    expect(await new ToolGate('read_only', never, ids).decide(webSearch)).toBe('decline');
  });
});

describe('web tool calls are recognised as web lookups', () => {
  it('Claude Code', () => {
    expect(claudeGateRequest('WebSearch', { query: 'x' }).web).toBe(true);
    expect(claudeGateRequest('WebFetch', { url: 'https://example.com' }).web).toBe(true);
    expect(claudeGateRequest('Bash', { command: 'ls' }).web).toBeUndefined();
  });

  it('Antigravity, even in a read-only run', () => {
    for (const name of ['search_web', 'read_url_content']) {
      const verdict = classifyAgyTool(name, { query: 'x', Url: 'https://example.com' }, '/w', true);
      expect(verdict).toMatchObject({ allow: false, request: { web: true } });
    }
    expect(classifyAgyTool('run_command', { CommandLine: 'curl x' }, '/w', true)).toEqual({ allow: 'never' });
  });

  it('OpenCode and Kiro over ACP', () => {
    expect(acpGateRequest('OpenCode', { kind: 'fetch', title: 'https://example.com', rawInput: { url: 'https://example.com' } }).web).toBe(true);
    expect(acpGateRequest('OpenCode', { title: 'websearch', rawInput: { query: 'x' } }).web).toBe(true);
    expect(acpGateRequest('Kiro CLI', { title: 'web_search', rawInput: { query: 'x' } }).web).toBe(true);
    expect(acpGateRequest('Kiro CLI', { title: 'web_fetch', rawInput: { url: 'https://example.com' } }).web).toBe(true);
    expect(acpGateRequest('Kiro CLI', { title: 'Running: curl x', rawInput: { command: 'curl x' } }).web).toBeUndefined();
  });
});

describe('CLI launches with web access', () => {
  const input = { objective: 'How big is it?', rootPath: '/tmp/chat-sandbox', mode: 'read_only' as const, taskId: 't', stepId: 's', conversationOnly: true };
  const prepare = (data: Record<string, unknown>): Promise<{ args: string[] }> => {
    const adapter = new ClaudeCodeAdapter({ id: 'claude-code', name: 'Claude Code', command: 'claude' } as never, never);
    return (adapter as unknown as { prepare(live: unknown): Promise<{ args: string[] }> }).prepare({ data, gate: {}, events: { push: () => {} }, cleanup: [] });
  };

  it('gives read-only Claude Code its web tools, pre-allowed', async () => {
    const { args } = await prepare({ ...input, webAccess: true });
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Glob,Grep,WebSearch,WebFetch');
    expect(args).toEqual(expect.arrayContaining(['--allowedTools', 'WebSearch', 'WebFetch']));
    expect(args).not.toContain('Bash');
  });

  it('gives read-only Claude Code with MCP servers its web tools too', async () => {
    const { args } = await prepare({ ...input, webAccess: true, mcpServers: [{ key: 'media', url: 'http://127.0.0.1:1/mcp' }] });
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Glob,Grep,WebSearch,WebFetch');
    expect(args).toEqual(expect.arrayContaining(['mcp__media__*', 'WebSearch', 'WebFetch']));
  });

  it('leaves other read-only Claude Code runs without web tools', async () => {
    const { args } = await prepare(input);
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Glob,Grep');
    expect(args).not.toContain('WebSearch');
  });

  it('turns on live web search for Codex only with web access', () => {
    expect(codexThreadConfig({ ...input, webAccess: true })).toEqual({ web_search: 'live' });
    expect(codexThreadConfig(input)).toBeUndefined();
  });
});
