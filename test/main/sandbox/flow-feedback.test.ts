import { describe, expect, it } from 'vitest';
import { applyFeedbackDecision, parseFeedbackDecision } from '@main/sandbox/flow-feedback';
import { flowProblem, type FlowNode } from '@shared/agent-flows';

const nodes: FlowNode[] = ['draft', 'check', 'review', 'publish', 'archive'].map((id) => ({ id, kind: id === 'review' ? 'review' : 'agent', agentId: '', prompt: id, x: 0, y: 0 }));
const definition = { name: 'Draft', nodes, edges: [{ from: 'draft', to: 'check' }, { from: 'check', to: 'review' }, { from: 'review', to: 'publish', when: { label: 'approve' } }, { from: 'review', to: 'archive' }] };
const decision = (next: string[]) => JSON.stringify({ route: { type: 'decision', next }, feedback: { summary: 'Shorten draft', instructions: ['Cut the introduction'] } });

describe('agent feedback DAG routing', () => {
  it('rewrites adjacency through an explicit rewind and fresh affected path', () => {
    const parsed = parseFeedbackDecision(decision(['draft']), definition, 'review');
    const changed = applyFeedbackDecision(definition, 'review', parsed, (id) => `new-${id}`);
    expect(flowProblem(changed.definition.nodes, changed.definition.edges)).toBeUndefined();
    expect(changed.definition.edges).toContainEqual({ from: 'review', to: 'new-rewind' });
    expect(changed.definition.edges).toContainEqual({ from: 'new-rewind', to: 'new-draft' });
    expect(changed.definition.edges).toContainEqual({ from: 'new-review', to: 'publish', when: { label: 'approve' } });
    expect(changed.definition.edges.some((e) => e.from === 'review' && e.to === 'publish')).toBe(false);
    expect(changed.added.map((n) => n.id)).toEqual(expect.arrayContaining(['new-rewind', 'new-draft', 'new-check', 'new-review']));
    expect(definition.edges).toHaveLength(4);
  });

  it('selects only the requested forward branches', () => {
    const parsed = parseFeedbackDecision(decision(['publish']), definition, 'review');
    const changed = applyFeedbackDecision(definition, 'review', parsed, (id) => `new-${id}`);
    expect(changed.added).toEqual([]);
    expect(changed.definition.edges.filter((e) => e.from === 'review')).toEqual([{ from: 'review', to: 'publish' }]);
  });

  it('rejects missing targets, mixed directions, duplicates and malformed feedback', () => {
    for (const next of [['ghost'], ['draft', 'publish'], ['publish', 'publish'], [], ['review']]) {
      expect(() => parseFeedbackDecision(decision(next), definition, 'review')).toThrow();
    }
    expect(() => parseFeedbackDecision('{"route":{"type":"decision","next":["draft"]}}', definition, 'review')).toThrow();
    expect(() => parseFeedbackDecision('not JSON', definition, 'review')).toThrow();
  });
});
