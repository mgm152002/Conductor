import { describe, expect, it } from 'vitest';
import { acpPlanLabel, acpToolDetail, acpToolLabel, acpToolOutput } from '@main/adapters/acp-agent-adapter';
import { agyToolDetail, agyToolKind, agyToolLabel, agyToolOutput } from '@main/adapters/antigravity-adapter';
import { claudeToolDetail, claudeToolKind, claudeToolLabel, claudeToolOutput } from '@main/adapters/claude-code-adapter';
import { execItem } from '@main/adapters/codex-app-server-adapter';

// The activity helpers turn protocol tool updates into the concise, human
// readable rows the thread timeline shows while an agent is working.
describe('agent activity labels', () => {
  it('summarizes ACP tool calls from commands, paths and raw input', () => {
    expect(acpToolDetail({ rawInput: { command: ['git', 'status', '--short'] } })).toBe('git status --short');
    expect(acpToolDetail({ locations: [{ path: '/w/src/a.ts' }], rawInput: { query: 'needle' } })).toBe('needle\n/w/src/a.ts');
    expect(acpToolDetail({ rawInput: { unexpected: true } })).toBe('{"unexpected":true}');
    expect(acpToolDetail({})).toBeUndefined();
  });

  it('labels ACP tool calls by what ran, not the folder path', () => {
    // OpenCode titles a read with the file's full path; the row must name the
    // tool and the file, not truncate into the folder path.
    expect(acpToolLabel({ kind: 'read', title: '/Users/x/chat-sandbox/attachments/a/b-image.png', locations: [{ path: '/Users/x/chat-sandbox/attachments/a/b-image.png' }] }))
      .toBe('Read b-image.png');
    expect(acpToolLabel({ kind: 'execute', title: 'Bash', rawInput: { command: 'npm test' } })).toBe('Run npm test');
    expect(acpToolLabel({ kind: 'search', rawInput: { pattern: 'needle' }, locations: [{ path: '/w/src' }] })).toBe('Search needle');
    expect(acpToolLabel({ kind: 'edit', locations: [{ path: '/w/src/a.ts' }] })).toBe('Edit a.ts');
    expect(acpToolLabel({ title: 'Ask the user a question' })).toBe('Ask the user a question');
  });

  it('surfaces ACP tool output from completion updates, capped and text-only', () => {
    expect(acpToolOutput({ content: [{ type: 'content', content: { type: 'text', text: 'file contents here' } }] }))
      .toBe('file contents here');
    expect(acpToolOutput({ rawOutput: { stdout: '3 passed' } })).toBe('3 passed');
    expect(acpToolOutput({ content: [{ type: 'content', content: { type: 'image', data: 'AAAA' } }] })).toBe('[image output]');
    expect(acpToolOutput({})).toBeUndefined();
    // The detail shown when the row expands carries arguments, then output.
    expect(acpToolDetail({
      locations: [{ path: '/w/a.txt' }],
      content: [{ type: 'content', content: { type: 'text', text: 'hello from the file' } }],
    })).toBe('/w/a.txt\n\nhello from the file');
    const long = acpToolOutput({ rawOutput: 'x'.repeat(5_000) })!;
    expect(long.length).toBeLessThan(4_100);
    expect(long).toContain('(output truncated)');
  });

  it('counts completed ACP plan entries', () => {
    expect(acpPlanLabel({ entries: [
      { content: 'Read', status: 'completed' },
      { content: 'Edit', status: 'in_progress' },
      { content: 'Test', status: 'pending' },
    ] })).toBe('Plan · 1/3 done');
    expect(acpPlanLabel({})).toBe('Plan updated');
  });

  it('maps Claude Code tools to timeline icons and short details', () => {
    expect(claudeToolKind('Bash')).toBe('execute');
    expect(claudeToolKind('Read')).toBe('read');
    expect(claudeToolKind('Grep')).toBe('search');
    expect(claudeToolKind('Write')).toBe('edit');
    expect(claudeToolKind('mcp__github__create_issue')).toBe('tool');
    expect(claudeToolDetail('Bash', { command: 'npm test' })).toBe('npm test');
    expect(claudeToolDetail('Grep', { pattern: 'needle', path: 'src' })).toBe('needle · src');
    expect(claudeToolDetail('Edit', { file_path: '/w/a.ts' })).toBe('/w/a.ts');
    expect(claudeToolDetail('Read', { description: 'Read the config' })).toBe('Read the config');
  });

  it('labels Claude Code tools by what ran and surfaces tool results', () => {
    expect(claudeToolLabel('Read', { file_path: '/w/photos/image.png' })).toBe('Read image.png');
    expect(claudeToolLabel('Bash', { command: 'npm test' })).toBe('Run npm test');
    expect(claudeToolLabel('Grep', { pattern: 'needle', path: 'src' })).toBe('Search needle');
    expect(claudeToolLabel('Edit', { file_path: '/w/src/a.ts' })).toBe('Edit a.ts');
    expect(claudeToolLabel('WebFetch', { url: 'https://example.com/docs' })).toBe('Fetch https://example.com/docs');
    expect(claudeToolOutput({ content: [{ type: 'text', text: '3 files matched' }] })).toBe('3 files matched');
    expect(claudeToolOutput({ content: 'plain output' })).toBe('plain output');
    expect(claudeToolOutput({ content: [{ type: 'image', source: {} }] })).toBe('[image output]');
    expect(claudeToolOutput({})).toBeUndefined();
  });

  it('labels Antigravity tools by what ran and surfaces step output', () => {
    expect(agyToolLabel('view_file', { args: { AbsolutePath: '/w/photos/image.png' } })).toBe('View image.png');
    expect(agyToolLabel('run_command', { args: { CommandLine: 'npm test' } })).toBe('Run npm test');
    expect(agyToolLabel('grep_search', { args: { Query: 'needle' } })).toBe('Search needle');
    expect(agyToolLabel('write_to_file', { args: { TargetFile: '/w/a.ts' } })).toBe('Write a.ts');
    expect(agyToolLabel('manage_task', {})).toBe('Manage task');
    expect(agyToolOutput({ response: 'done reading' })).toBe('done reading');
    expect(agyToolOutput({ args: { output: '3 passed' } })).toBe('3 passed');
    expect(agyToolOutput({})).toBeUndefined();
  });

  it('carries Codex MCP output, web searches and image views into timeline items', () => {
    expect(execItem({ type: 'mcpToolCall', id: 'm', server: 'github', tool: 'get_issue', status: 'completed', result: { content: [{ type: 'text', text: 'Issue #4: Bug' }] } }))
      .toEqual({ id: 'm', type: 'mcp_tool_call', server: 'github', tool: 'get_issue', status: 'completed', output: 'Issue #4: Bug' });
    expect(execItem({ type: 'mcpToolCall', id: 'm', server: 'github', tool: 'get_issue', status: 'failed', error: { message: 'denied' } }))
      .toEqual({ id: 'm', type: 'mcp_tool_call', server: 'github', tool: 'get_issue', status: 'failed', output: 'denied' });
    expect(execItem({ type: 'webSearch', id: 'w', action: { type: 'search', query: 'best coffee lisbon' } }))
      .toEqual({ id: 'w', type: 'web_search', query: 'best coffee lisbon' });
    expect(execItem({ type: 'imageView', id: 'i', path: '/w/photos/image.png' }))
      .toEqual({ id: 'i', type: 'image_view', path: '/w/photos/image.png' });
    expect(execItem({ type: 'fileChange', id: 'f', status: 'completed', changes: [{ path: 'a.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@' }] }))
      .toEqual({ id: 'f', type: 'file_change', status: 'completed', changes: [{ path: 'a.ts', kind: 'update', diff: '@@ -1 +1 @@' }] });
  });

  it('maps Antigravity tools to timeline icons and short details', () => {
    expect(agyToolKind('run_command')).toBe('execute');
    expect(agyToolKind('replace_file_content')).toBe('edit');
    expect(agyToolKind('grep_search')).toBe('search');
    expect(agyToolKind('view_file')).toBe('read');
    expect(agyToolKind('list_resources')).toBe('search');
    expect(agyToolDetail({ args: { CommandLine: 'npm test' } })).toBe('npm test');
    expect(agyToolDetail({ args: { AbsolutePath: '/w/a.ts' } })).toBe('/w/a.ts');
    expect(agyToolDetail({ args: { toolSummary: 'Checked permissions' } })).toBe('Checked permissions');
    expect(agyToolDetail({})).toBeUndefined();
  });
});
