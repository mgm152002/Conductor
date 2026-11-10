import { create } from 'zustand';
import type { AgentGroup, SandboxAgent } from '@shared/sandbox-agents';

// Sandbox agents and which thread each one runs, for the Agents screen, the
// composer's agent picker and the thread header. Loaded once at startup and
// refreshed after any change.

/** Composer agent values for a sandbox agent are prefixed so they never collide with CLI ids. */
export const SANDBOX_AGENT_PREFIX = 'sandbox:';

export function sandboxAgentIdFrom(value: string): string | undefined {
  return value.startsWith(SANDBOX_AGENT_PREFIX) ? value.slice(SANDBOX_AGENT_PREFIX.length) : undefined;
}

interface SandboxAgentState {
  agents: SandboxAgent[];
  /** Thread id → agent id. */
  threads: Record<string, string>;
  groups: AgentGroup[];
  /** Threads that belong to group chats rather than an agent's own chat → their group. */
  groupThreads: Record<string, string>;
  loaded: boolean;
  refresh: () => Promise<void>;
  /** The conversation open on the Agents screen. */
  selection: AgentSelection;
  /** A specific 1:1 thread to show when its agent opens (from the inbox). */
  focusThread: string | null;
  select: (selection: AgentSelection, focusThread?: string | null) => void;
  /** Open whichever conversation holds this thread; false when it isn't an agent thread. */
  openThread: (threadKey: string) => boolean;
}

export type AgentSelection = { kind: 'agent' | 'group'; id: string } | null;
const SELECTION_KEY = 'conductor.agents.selection';

function loadSelection(): AgentSelection {
  try { const raw = window.localStorage.getItem(SELECTION_KEY); return raw === null ? null : JSON.parse(raw) as AgentSelection; } catch { return null; }
}

export const useSandboxAgentStore = create<SandboxAgentState>((set, get) => ({
  agents: [],
  threads: {},
  groups: [],
  groupThreads: {},
  loaded: false,
  selection: loadSelection(),
  focusThread: null,
  select: (selection, focusThread = null) => {
    try { window.localStorage.setItem(SELECTION_KEY, JSON.stringify(selection)); } catch { /* session only */ }
    set({ selection, focusThread });
  },
  openThread: (threadKey) => {
    const { threads, groupThreads, select } = get();
    const groupId = groupThreads[threadKey];
    if (groupId !== undefined) { select({ kind: 'group', id: groupId }); return true; }
    const agentId = threads[threadKey];
    if (agentId === undefined) return false;
    select({ kind: 'agent', id: agentId }, threadKey);
    return true;
  },
  refresh: async () => {
    try {
      const [agents, threads, groups] = await Promise.all([
        window.conductor.sandboxAgents.list(), window.conductor.sandboxAgents.threads(), window.conductor.sandboxAgents.groups(),
      ]);
      set({ agents, threads, groups: groups.groups, groupThreads: groups.groupThreads, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
}));

/** The agent that runs a thread, if any. */
export function useThreadSandboxAgent(threadId: string | null): SandboxAgent | undefined {
  return useSandboxAgentStore((state) => {
    if (threadId === null) return undefined;
    const id = state.threads[threadId];
    return id === undefined ? undefined : state.agents.find((agent) => agent.id === id);
  });
}
