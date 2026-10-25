import { describe, expect, it } from 'vitest';
import { computeWaves, extractPlanJson, planSlug, referencedCriteria, renderTasks, validatePlan, wavesJson } from '@main/plan/plan-doc';
import { usageFromEvent } from '@main/usage/usage';
import { claudeUsage } from '@main/adapters/claude-code-adapter';

const agents = new Set(['codex', 'claude-code']);
const task = (id: string, dependsOn: string[] = [], agent = 'codex') => ({ id, title: `Task ${id}`, dependsOn, agent });
const plan = (tasks: ReturnType<typeof task>[]) => ({
  title: 'T', requirements: [{ id: '1', title: 'R', acceptanceCriteria: ['a', 'b'] }],
  groups: [{ id: '1', title: 'G', tasks }],
});

describe('plan validation', () => {
  it('computes waves from dependencies, like a spec dependency graph', () => {
    const p = validatePlan(plan([task('1.1'), task('1.2', ['1.1']), task('2.1', ['1.1']), task('2.2'), task('3.1', ['1.2', '2.1'])]), agents, 'codex');
    const waves = computeWaves(p);
    expect(waves).toEqual([{ id: 0, tasks: ['1.1', '2.2'] }, { id: 1, tasks: ['1.2', '2.1'] }, { id: 2, tasks: ['3.1'] }]);
    expect(wavesJson(waves)).toBe('{\n  "waves": [\n    { "id": 0, "tasks": ["1.1", "2.2"] },\n    { "id": 1, "tasks": ["1.2", "2.1"] },\n    { "id": 2, "tasks": ["3.1"] }\n  ]\n}');
  });

  it('rejects duplicate ids, unknown dependencies, self-dependencies, cycles and oversized plans', () => {
    expect(() => validatePlan(plan([task('1.1'), task('1.1')]), agents, 'codex')).toThrow('used twice');
    expect(() => validatePlan(plan([task('1.1', ['9.9'])]), agents, 'codex')).toThrow('unknown task 9.9');
    expect(() => validatePlan(plan([task('1.1', ['1.1'])]), agents, 'codex')).toThrow('itself');
    expect(() => validatePlan(plan([task('1.1', ['1.2']), task('1.2', ['1.1'])]), agents, 'codex')).toThrow('cycle');
    expect(() => validatePlan(plan(Array.from({ length: 13 }, (_, i) => task(`1.${i + 1}`))), agents, 'codex')).toThrow();
    expect(() => validatePlan({ title: 'x' }, agents, 'codex')).toThrow('malformed');
  });

  it('assigns unknown or unavailable agents to the fallback agent and reports each switch', () => {
    const reassigned: { planTaskId: string; title: string; requestedAgent: string }[] = [];
    const p = validatePlan({ ...plan([]), groups: [{ id: 1, title: 'G', tasks: [{ id: 1.1, title: 'A', agent: 'not-installed' }, { id: '1.2', title: 'B', agent: 'claude-code', dependsOn: [1.1] }] }] }, new Set(['opencode', 'claude-code']), 'opencode', (fallback) => { reassigned.push(fallback); });
    expect(p.groups[0]!.tasks.map((t) => [t.id, t.agent, t.dependsOn])).toEqual([['1.1', 'opencode', []], ['1.2', 'claude-code', ['1.1']]]);
    expect(reassigned).toEqual([{ planTaskId: '1.1', title: 'A', requestedAgent: 'not-installed' }]);
  });

  it('extracts the JSON plan from a reply', () => {
    expect(extractPlanJson('Sure.\n```json\n{"title":"A"}\n```\nDone')).toEqual({ title: 'A' });
    expect(extractPlanJson('{"title":"B"}')).toEqual({ title: 'B' });
    expect(() => extractPlanJson('no plan here')).toThrow('did not reply with a JSON plan');
  });

  it('renders tasks.md with checkboxes, agents and the waves block', () => {
    const p = validatePlan(plan([task('1.1'), task('1.2', ['1.1'], 'claude-code')]), agents, 'codex');
    const md = renderTasks(p, { objective: 'Do it', plannerName: 'Codex', agentName: (id) => (id === 'codex' ? 'Codex CLI' : 'Claude Code'),
      status: (id) => (id === '1.1' ? 'succeeded' : 'running') });
    expect(md).toContain('- [ ] 1. G');
    expect(md).toContain('  - [x] 1.1 Task 1.1');
    expect(md).toContain('  - [-] 1.2 Task 1.2');
    expect(md).toContain('    - _Depends on: 1.1_');
    expect(md).toContain('    - _Agent: Claude Code · moderate_');
    expect(md).toContain('## Task Dependency Graph\n\n```json\n{\n  "waves": [');
    expect(planSlug('Add Dark Mode!', new Date('2026-10-24T10:00:00Z'))).toBe('2026-10-24-add-dark-mode');
    expect(referencedCriteria({ ...p, requirements: [{ id: '1', title: 'R', acceptanceCriteria: ['a', 'b'] }] }, { ...p.groups[0]!.tasks[0]!, requirements: ['1.2'] })).toEqual(['1.2 b']);
  });
});

describe('usage parsing', () => {
  it('reads codex exec turn.completed usage and adapter usage logs', () => {
    expect(usageFromEvent({ kind: 'stdout', sequence: 1, at: '', data: '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":3}}' }))
      .toEqual({ inputTokens: 10, cachedInputTokens: 4, outputTokens: 3 });
    expect(usageFromEvent({ kind: 'stdout', sequence: 1, at: '', data: '{"type":"turn.completed","usage":{}}' })).toBeUndefined();
    expect(usageFromEvent({ kind: 'log', sequence: 1, at: '', data: { usage: { inputTokens: 5, model: 'gpt-x', costUsd: -1 } } })).toEqual({ inputTokens: 5, model: 'gpt-x' });
    expect(usageFromEvent({ kind: 'log', sequence: 1, at: '', data: { message: 'hi' } })).toBeUndefined();
  });

  it('reads the Claude Code result envelope', () => {
    expect(claudeUsage({ type: 'result', total_cost_usd: 0.02, usage: { input_tokens: 10, cache_read_input_tokens: 50, cache_creation_input_tokens: 5, output_tokens: 7, output_tokens_details: { thinking_tokens: 2 } }, modelUsage: { 'claude-sonnet-5': {} } }))
      .toEqual({ inputTokens: 65, cachedInputTokens: 50, outputTokens: 7, reasoningTokens: 2, totalTokens: 72, costUsd: 0.02, model: 'claude-sonnet-5' });
  });
});
