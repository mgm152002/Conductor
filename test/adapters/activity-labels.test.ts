import { describe, expect, it } from 'vitest';
import { acpPlanLabel, acpToolDetail } from '@main/adapters/acp-agent-adapter';
import { agyToolDetail, agyToolKind } from '@main/adapters/antigravity-adapter';
import { claudeToolDetail, claudeToolKind } from '@main/adapters/claude-code-adapter';

// The activity helpers turn protocol tool updates into the concise, human
// readable rows the thread timeline shows while an agent is working.
describe('agent activity labels', () => {
  it('summarizes ACP tool calls from commands, paths and raw input', () => {
    expect(acpToolDetail({ rawInput: { command: ['git', 'status', '--short'] } })).toBe('git status --short');
    expect(acpToolDetail({ locations: [{ path: '/w/src/a.ts' }], rawInput: { query: 'needle' } })).toBe('needle\n/w/src/a.ts');
    expect(acpToolDetail({ rawInput: { unexpected: true } })).toBe('{"unexpected":true}');
    expect(acpToolDetail({})).toBeUndefined();
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
