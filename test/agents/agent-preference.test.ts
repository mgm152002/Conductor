import { describe, expect, it } from 'vitest';
import {
  AGENT_PREFERENCE_ORDER,
  agentPreferenceRank,
  compareAgentPreference,
  preferredAgent,
} from '@shared/agent-preference';

describe('agent preference', () => {
  it('puts OpenCode ahead of Antigravity and the other runnable CLIs', () => {
    expect(AGENT_PREFERENCE_ORDER[0]).toBe('opencode');
    expect(agentPreferenceRank('opencode')).toBeLessThan(agentPreferenceRank('antigravity'));
    expect(agentPreferenceRank('opencode')).toBeLessThan(agentPreferenceRank('kiro'));
  });

  it('sorts by preference, with unknown agents after known ones in id order', () => {
    const sorted = ['antigravity', 'remote:zeta', 'opencode', 'alpha', 'kiro'].sort(compareAgentPreference);
    expect(sorted).toEqual(['opencode', 'antigravity', 'kiro', 'alpha', 'remote:zeta']);
  });

  it('selects the most preferred available agent', () => {
    expect(preferredAgent(['antigravity', 'kiro'])).toBe('antigravity');
    expect(preferredAgent(['kiro', 'opencode', 'antigravity'])).toBe('opencode');
    expect(preferredAgent([])).toBeUndefined();
  });
});
