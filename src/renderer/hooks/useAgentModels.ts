import { useEffect, useState } from 'react';
import type { AgentModelCatalog } from '@shared/agent-models';

// Each agent's model list, loaded once per session (the main process caches
// the CLI's answer for 10 minutes).

const cache = new Map<string, Promise<AgentModelCatalog>>();

export function loadAgentModels(agentId: string, refresh = false): Promise<AgentModelCatalog> {
  if (refresh || !cache.has(agentId)) {
    cache.set(agentId, window.conductor.agents.models(agentId, refresh).catch((err: unknown) => {
      cache.delete(agentId);
      return { agentId, models: [], efforts: [], source: 'none' as const, error: err instanceof Error ? err.message : String(err) };
    }));
  }
  return cache.get(agentId)!;
}

export function useAgentModels(agentId: string | undefined): AgentModelCatalog | null {
  const [catalog, setCatalog] = useState<AgentModelCatalog | null>(null);
  useEffect(() => {
    let active = true;
    setCatalog(null);
    if (agentId === undefined) return;
    void loadAgentModels(agentId).then((c) => { if (active) setCatalog(c); });
    return () => { active = false; };
  }, [agentId]);
  return catalog;
}
