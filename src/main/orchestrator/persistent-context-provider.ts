import type { Store } from '../db/types';
import { MemoryEngine } from '../domain/memory-engine';
import type { ContextBundle, ContextProvider, ContextRequest } from './context-provider';

export const MAX_SOURCE_MATCHES = 6;

/** Relational authorization precedes Mem0 ranking and limits. No trust changes. */
export class PersistentContextProvider implements ContextProvider {
  constructor(private readonly store: Store, private readonly now: () => number = Date.now,
    private readonly memory: MemoryEngine = new MemoryEngine(store, now)) {}

  /** Rechecked at content resolution too: persisted task refs are not authority. */
  eligibleMemoryIds(request: Pick<ContextRequest, 'workspaceId' | 'taskId'>, sources: boolean): string[] {
    const predicate = sources
      ? `scope_level='source' AND scope_ref_id IN (SELECT id FROM connectors WHERE auth_state='authorized' AND json_extract(config,'$.workspaceId')=@workspaceId)`
      : `(scope_level='global' AND scope_ref_id IS NULL) OR (scope_level='project' AND scope_ref_id=@workspaceId) OR (scope_level='task' AND scope_ref_id=@taskId)`;
    return (this.store.db.prepare(`SELECT id FROM memories WHERE (${predicate}) AND superseded_by IS NULL AND (expires_at IS NULL OR expires_at>@now)`)
      .all({ workspaceId: request.workspaceId, taskId: request.taskId, now: new Date(this.now()).toISOString() }) as { id: string }[]).map((r) => r.id);
  }

  indexingEnabled(): boolean {
    const row = this.store.db.prepare("SELECT value_json FROM preferences WHERE key='data.indexingEnabled' AND scope='global'").get() as { value_json: string } | undefined;
    return !row || JSON.parse(row.value_json) !== false;
  }

  /** Fetch content at the point of use; saved task references grant no access. */
  async resolveContent(request: Pick<ContextRequest, 'workspaceId' | 'taskId'>, refs: readonly string[]): Promise<Record<string, unknown>[]> {
    if (!this.indexingEnabled()) return [];
    const eligible = new Set([...this.eligibleMemoryIds(request, false), ...this.eligibleMemoryIds(request, true)]);
    const result: Record<string, unknown>[] = [];
    for (const id of refs) {
      const item = this.store.db.prepare(`SELECT content,veracity,confidence FROM context_items WHERE id=? AND (
        (scope_level='global' AND scope_ref_id IS NULL) OR (scope_level='project' AND scope_ref_id=?) OR (scope_level='task' AND scope_ref_id=?))`)
        .get(id, request.workspaceId, request.taskId) as Record<string, unknown> | undefined;
      if (item) result.push({ id, ...item, trust: 'untrusted_reference_data' });
      else if (eligible.has(id)) {
        const record = await this.memory.find(id);
        if (record && this.indexingEnabled() && this.eligibleMemoryIds(request, record.scope.level === 'source').includes(id)) {
          result.push({ id, content: record.content, veracity: record.veracity, confidence: record.confidence, trust: 'untrusted_reference_data' });
        }
      }
    }
    return result;
  }

  async retrieveContext(request: ContextRequest): Promise<ContextBundle> {
    try {
      if (!this.indexingEnabled()) return { refs: [] };
      const contexts = this.store.db.prepare(`SELECT id FROM context_items WHERE
        (scope_level='global' AND scope_ref_id IS NULL) OR (scope_level='project' AND scope_ref_id=@workspaceId)
        OR (scope_level='task' AND scope_ref_id=@taskId) ORDER BY updated_at DESC, rowid DESC LIMIT 100`)
        .all({ workspaceId: request.workspaceId, taskId: request.taskId }) as { id: string }[];
      let memories: Awaited<ReturnType<MemoryEngine['search']>> = [];
      let sources: typeof memories = [];
      try {
        memories = await this.memory.search({ limit: 100 }, this.eligibleMemoryIds(request, false));
        sources = request.objective.trim()
          ? await this.memory.search({ text: request.objective, limit: MAX_SOURCE_MATCHES }, this.eligibleMemoryIds(request, true)) : [];
      } catch { /* SQL context remains useful while Mem0 is unavailable. */ }
      const eligible = new Set([...this.eligibleMemoryIds(request, false), ...this.eligibleMemoryIds(request, true)]);
      return { refs: [...new Set([...contexts.map((r) => r.id), ...[...memories, ...sources].map((r) => r.memory.id).filter((id) => eligible.has(id))])] };
    } catch {
      // Provider contract is best-effort. Explicit memory operations surface errors.
      return { refs: [] };
    }
  }
}
