import type { Mem0Client, Mem0Memory } from '../domain/mem0-client';

/**
 * Agents' long-term memory, kept in Mem0 under namespaces of their own. The
 * project store uses a different Mem0 user and run ids, so nothing an agent
 * saves is mixed into it or read back as project context.
 *
 *  - `conductor-agent-<id>`: one agent's private notes; no other agent reads them.
 *  - `conductor-agents-shared`: knowledge every agent reads and adds to,
 *    including the files copied from the shared Docker volume.
 */
export const AGENT_MEMORY_PREFIX = 'conductor-agent-';
export const SHARED_MEMORY_NAMESPACE = 'conductor-agents-shared';

export const agentMemoryNamespace = (agentId: string): string => `${AGENT_MEMORY_PREFIX}${agentId}`;

export type MemoryScope = 'private' | 'shared';

export interface AgentMemoryStore {
  save(text: string, scope?: string): Promise<string>;
  search(query: string, scope?: string): Promise<string>;
  forget(id: string): Promise<string>;
}

export type Mem0Notes = Pick<Mem0Client, 'addNote' | 'searchNotes' | 'listNotes' | 'get' | 'delete'>;

const MAX_NOTE = 4_000;
const SEARCH_LIMIT = 8;

/** The agent's memory tools' behaviour over a Mem0 client, for one agent. */
export function agentMemory(mem0: Mem0Notes, agentId: string): AgentMemoryStore {
  const own = agentMemoryNamespace(agentId);
  const label = (memory: Mem0Memory, scope: MemoryScope): string => `- [${memory.id}] (${scope}) ${memory.memory}`;
  const find = async (user: string, query: string): Promise<Mem0Memory[]> => (query === '' ? mem0.listNotes(user, SEARCH_LIMIT) : mem0.searchNotes(user, query, SEARCH_LIMIT));
  return {
    async save(text, scope = 'private') {
      const note = text.trim().slice(0, MAX_NOTE);
      if (note === '') throw new Error('Give the text to remember.');
      const shared = scope === 'shared';
      const saved = await mem0.addNote(shared ? SHARED_MEMORY_NAMESPACE : own, note, { source: 'agent', conductor_agent: agentId });
      return `Remembered${shared ? ' for all agents' : ''} (id ${saved.id}).`;
    },
    async search(query, scope = 'all') {
      const q = query.trim();
      const lines: string[] = [];
      if (scope !== 'shared') lines.push(...(await find(own, q)).map((m) => label(m, 'private')));
      if (scope !== 'private') lines.push(...(await find(SHARED_MEMORY_NAMESPACE, q)).map((m) => label(m, 'shared')));
      return lines.length === 0 ? 'Nothing saved matches.' : lines.join('\n');
    },
    async forget(id) {
      const memory = await mem0.get(id);
      const mine = memory.user_id === own;
      // Shared notes may be corrected by any agent, but the volume's copied
      // files are refreshed from their source, so only agent-written ones go.
      const sharedByAgent = memory.user_id === SHARED_MEMORY_NAMESPACE && memory.metadata?.['source'] === 'agent';
      if (!mine && !sharedByAgent) throw new Error('That memory is not yours to remove.');
      await mem0.delete(id);
      return `Forgot ${id}.`;
    },
  };
}
