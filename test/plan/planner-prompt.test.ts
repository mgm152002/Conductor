import { describe, expect, it } from 'vitest';
import { plannerPrompt } from '@main/plan/agent-planner';

describe('planner prompt', () => {
  it('names the preferred fallback agent and asks for parallel distribution', () => {
    const prompt = plannerPrompt({
      objective: 'Add notes',
      criteria: [],
      agents: '- "opencode" (OpenCode)\n- "antigravity" (Antigravity CLI)',
      fallbackAgentId: 'opencode',
    });
    expect(prompt).toContain('If unsure, use "opencode"');
    expect(prompt).not.toContain('use "antigravity"');
    expect(prompt).toContain('Independent tasks in the same wave should use different agents');
  });
});
