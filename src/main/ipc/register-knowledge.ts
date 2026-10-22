import { KNOWLEDGE_SCHEMAS, type KnowledgeDeletion, type KnowledgeRequest } from '@shared/knowledge-contract';
import type { ContextScope } from '@shared/domain';
import type { Store } from '../db/types';
import type { ContextEngine } from '../domain/context-engine';
import type { MemoryEngine } from '../domain/memory-engine';
import type { IpcRouter } from './router';

interface KnowledgeDeps { store: Store; memory: MemoryEngine; context: ContextEngine }
function scope(input: KnowledgeRequest<'context.create'>['scope']): ContextScope {
  return { level: input.level, ...(input.refId !== undefined ? { refId: input.refId } : {}) };
}

/** User-only operations. Agent retrieval never calls this correction surface. */
export function createKnowledgeService({ store, memory, context }: KnowledgeDeps) {
  return {
    memory: {
      search(input: KnowledgeRequest<'memory.search'>) {
        return memory.search({
          ...(input.text !== undefined ? { text: input.text } : {}),
          ...(input.layer !== undefined ? { layer: input.layer } : {}),
          ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
          ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
          ...(input.createdAfter !== undefined ? { createdAfter: input.createdAfter } : {}),
          ...(input.createdBefore !== undefined ? { createdBefore: input.createdBefore } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        });
      },
      create(input: KnowledgeRequest<'memory.create'>) {
        return memory.create({
          scope: scope(input.scope), layer: input.layer, content: input.content,
          veracity: input.veracity ?? 'unverified_assumption', confidence: input.confidence ?? 0,
          provenance: { method: 'user_stated', sourceId: 'user' },
          ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        });
      },
      async inspect(id: string) { return { memory: await memory.inspect(id), events: memory.provenanceEvents(id) }; },
      async correct(input: KnowledgeRequest<'memory.correct'>) {
          const old = await memory.inspect(input.id);
          if (old.supersededBy !== undefined) throw new Error('This memory has been replaced. Correct its replacement instead.');
          const next = await memory.supersede(old.id, {
            layer: old.layer, scope: old.scope, content: input.content,
            provenance: { method: 'user_stated', sourceId: 'user' },
            ...(old.expiresAt !== undefined ? { expiresAt: old.expiresAt } : {}),
          });
          return memory.promoteToFact(next.id, { kind: 'user_correction', sourceId: 'user' });
      },
      async delete(id: string): Promise<KnowledgeDeletion> {
          const cleanup = await memory.delete(id);
          return { id, deleted: true, ...cleanup };
      },
    },
    context: {
      list(input: KnowledgeRequest<'context.list'>) {
        const clauses: string[] = [];
        const params: unknown[] = [];
        if (input.scope !== undefined) {
          clauses.push('scope_level = ?'); params.push(input.scope.level);
          if (input.scope.refId === undefined) clauses.push('scope_ref_id IS NULL');
          else { clauses.push('scope_ref_id = ?'); params.push(input.scope.refId); }
        }
        // instr treats user search text literally rather than as SQL wildcard syntax.
        if (input.text?.trim()) { clauses.push('instr(lower(content), lower(?)) > 0'); params.push(input.text.trim()); }
        const rows = store.db.prepare(`SELECT id FROM context_items ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY updated_at DESC, rowid DESC LIMIT ?`).all(...params, input.limit ?? 100) as { id: string }[];
        return rows.map((row) => context.inspect(row.id));
      },
      create(input: KnowledgeRequest<'context.create'>) {
        return context.create({ scope: scope(input.scope), content: input.content,
          veracity: input.veracity ?? 'unverified_assumption', confidence: input.confidence ?? 0,
          provenance: [{ method: 'user_stated', sourceId: 'user' }] });
      },
      inspect(id: string) { return context.inspect(id); },
      correct(input: KnowledgeRequest<'context.correct'>) { return context.correct(input.id, { content: input.content }); },
      delete(id: string): KnowledgeDeletion { context.delete(id); return { id, deleted: true }; },
    },
  };
}

export function registerKnowledgeHandlers(deps: KnowledgeDeps & { router: IpcRouter }): void {
  const service = createKnowledgeService(deps);
  const { router } = deps;
  router.handle('memory.search', KNOWLEDGE_SCHEMAS['memory.search'], (_event, input) => service.memory.search(input));
  router.handle('memory.create', KNOWLEDGE_SCHEMAS['memory.create'], (_event, input) => service.memory.create(input));
  router.handle('memory.inspect', KNOWLEDGE_SCHEMAS['memory.inspect'], (_event, input) => service.memory.inspect(input.id));
  router.handle('memory.correct', KNOWLEDGE_SCHEMAS['memory.correct'], (_event, input) => service.memory.correct(input));
  router.handle('memory.delete', KNOWLEDGE_SCHEMAS['memory.delete'], (_event, input) => service.memory.delete(input.id));
  router.handle('context.list', KNOWLEDGE_SCHEMAS['context.list'], (_event, input) => service.context.list(input));
  router.handle('context.create', KNOWLEDGE_SCHEMAS['context.create'], (_event, input) => service.context.create(input));
  router.handle('context.inspect', KNOWLEDGE_SCHEMAS['context.inspect'], (_event, input) => service.context.inspect(input.id));
  router.handle('context.correct', KNOWLEDGE_SCHEMAS['context.correct'], (_event, input) => service.context.correct(input));
  router.handle('context.delete', KNOWLEDGE_SCHEMAS['context.delete'], (_event, input) => service.context.delete(input.id));
}
