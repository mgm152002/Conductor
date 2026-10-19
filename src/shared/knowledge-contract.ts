import { z } from 'zod';
import type { ContextItem, MemoryProvenanceEvent, MemoryRecord, MemorySearchHit } from './domain';

const identifier = z.string().trim().min(1).max(255);
const content = z.string().trim().min(1).max(100_000);
const timestamp = z.iso.datetime({ offset: true });
export const KnowledgeScopeSchema = z.object({
  level: z.enum(['global', 'project', 'task', 'workflow', 'source']),
  refId: identifier.optional(),
}).refine((scope) => scope.level === 'global' ? scope.refId === undefined : scope.refId !== undefined, {
  message: 'Global scope has no owner; other scopes require an owner ID', path: ['refId'],
});
export const MemoryLayerSchema = z.enum(['personal', 'project', 'task', 'procedural']);
export const KnowledgeVeracitySchema = z.enum(['observed_fact', 'inferred', 'unverified_assumption']);
const create = z.object({
  content, scope: KnowledgeScopeSchema,
  veracity: KnowledgeVeracitySchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
});
export const KNOWLEDGE_SCHEMAS = {
  'memory.search': z.object({
    text: z.string().max(10_000).optional(), layer: MemoryLayerSchema.optional(),
    projectId: identifier.optional(), sourceId: identifier.optional(),
    createdAfter: timestamp.optional(), createdBefore: timestamp.optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }).refine((q) => !q.createdAfter || !q.createdBefore || Date.parse(q.createdAfter) <= Date.parse(q.createdBefore), { message: 'Start time must be before end time' }),
  'memory.create': create.extend({ layer: MemoryLayerSchema, expiresAt: timestamp.optional() }),
  'memory.inspect': z.object({ id: identifier }),
  'memory.correct': z.object({ id: identifier, content }),
  'memory.delete': z.object({ id: identifier }),
  'context.list': z.object({ scope: KnowledgeScopeSchema.optional(), text: z.string().max(10_000).optional(), limit: z.number().int().min(1).max(500).optional() }),
  'context.create': create,
  'context.inspect': z.object({ id: identifier }),
  'context.correct': z.object({ id: identifier, content }),
  'context.delete': z.object({ id: identifier }),
} as const;
export type KnowledgeRequest<C extends keyof typeof KNOWLEDGE_SCHEMAS> = z.infer<(typeof KNOWLEDGE_SCHEMAS)[C]>;
export interface MemoryInspection { memory: MemoryRecord; events: MemoryProvenanceEvent[] }
export interface KnowledgeDeletion {
  id: string;
  deleted: true;
  /** Local deletion succeeded; remote Mem0 cleanup is queued for retry. */
  memoryCleanupPending?: boolean;
}

/** Type-only import in the sandboxed preload; schemas stay in the main process. */
export interface KnowledgeBridge {
  memory: {
    search(input: KnowledgeRequest<'memory.search'>): Promise<MemorySearchHit[]>;
    create(input: KnowledgeRequest<'memory.create'>): Promise<MemoryRecord>;
    inspect(id: string): Promise<MemoryInspection>;
    correct(input: KnowledgeRequest<'memory.correct'>): Promise<MemoryRecord>;
    delete(id: string): Promise<KnowledgeDeletion>;
  };
  context: {
    list(input: KnowledgeRequest<'context.list'>): Promise<ContextItem[]>;
    create(input: KnowledgeRequest<'context.create'>): Promise<ContextItem>;
    inspect(id: string): Promise<ContextItem>;
    correct(input: KnowledgeRequest<'context.correct'>): Promise<ContextItem>;
    delete(id: string): Promise<KnowledgeDeletion>;
  };
}
