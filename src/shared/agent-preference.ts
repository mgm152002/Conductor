// Deterministic preference order for the runnable agent CLIs.
//
// The order answers a narrow question: when two agents are equally eligible
// (same capability, cost and latency, no history that separates them), which
// one should Conductor use? It is the default planner in the composer, the
// default casual-chat agent, the fallback assignee for plan tasks the planner
// did not name, and the routing tiebreaker for Auto tasks.
//
// OpenCode leads deliberately: it is the CLI Conductor exercises plan mode
// with, and it must not lose to Antigravity merely because "antigravity" sorts
// first alphabetically. An explicit user choice and a plan task's required
// capability still take precedence; this list only breaks ties.

export const AGENT_PREFERENCE_ORDER = [
  'opencode',
  'codex',
  'claude-code',
  'antigravity',
  'kiro',
] as const;

const PREFERENCE_RANK: ReadonlyMap<string, number> = new Map(
  AGENT_PREFERENCE_ORDER.map((id, index): [string, number] => [id, index]),
);

/** Lower is more preferred. Agents outside the list rank after every listed one. */
export function agentPreferenceRank(agentId: string): number {
  return PREFERENCE_RANK.get(agentId) ?? AGENT_PREFERENCE_ORDER.length;
}

/** Total order: preference rank first, then lexicographic id for determinism. */
export function compareAgentPreference(a: string, b: string): number {
  const rank = agentPreferenceRank(a) - agentPreferenceRank(b);
  if (rank !== 0) return rank;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The most preferred id in `ids`, or undefined when the iterable is empty. */
export function preferredAgent(ids: Iterable<string>): string | undefined {
  let best: string | undefined;
  for (const id of ids) {
    if (best === undefined || compareAgentPreference(id, best) < 0) best = id;
  }
  return best;
}
