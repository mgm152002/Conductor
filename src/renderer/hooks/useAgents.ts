import { useEffect, useState } from 'react';
import type { AgentOption } from '@shared/integrations-contract';
import { compareAgentPreference } from '@shared/agent-preference';

/** Agents that can run a task (local CLIs and remote hosts), refreshed periodically. */
export function useAgents(): AgentOption[] {
  const [agents, setAgents] = useState<AgentOption[]>([]);
  useEffect(() => {
    let active = true;
    const load = (): void => { void window.conductor.agents.list()
      .then((list) => {
        if (!active) return;
        const sorted = [...list].sort((a, b) => compareAgentPreference(a.id, b.id));
        // Keep the same array when nothing changed, so users of the list don't re-render every poll.
        setAgents((current) => (JSON.stringify(current) === JSON.stringify(sorted) ? current : sorted));
      })
      .catch(() => {}); };
    load();
    const timer = window.setInterval(load, 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  return agents;
}
