import { mockMem0 } from '../helpers/mem0';
let mock: ReturnType<typeof mockMem0>;
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '@main/db/store';
import { ContextEngine } from '@main/domain/context-engine';
import { MemoryEngine } from '@main/domain/memory-engine';
import { createKnowledgeService } from '@main/ipc/register-knowledge';
import { PersistentContextProvider } from '@main/orchestrator/persistent-context-provider';
import { KNOWLEDGE_SCHEMAS } from '@shared/knowledge-contract';
import { WorkspaceService } from '@main/domain/workspace-service';
import { AuditLog } from '@main/domain/audit-log';
import { deleteProject } from '@main/domain/project-deletion';
let store: SqliteStore;
let context: ContextEngine;
let memory: MemoryEngine;
let service: ReturnType<typeof createKnowledgeService>;
const now = Date.parse('2026-01-01T00:00:00Z');
beforeEach(async () => {
    mock = mockMem0();
    store = new SqliteStore(':memory:');
    await store.migrate();
    context = new ContextEngine(store, () => now);
    memory = new MemoryEngine(store, () => now, mock.client);
    service = createKnowledgeService({ store, context, memory });
});
afterEach(() => store?.close());
it('requires a scope owner outside global scope and rejects invalid dates and confidence', () => {
    const base = { layer: 'project', scope: { level: 'project' }, content: 'A useful note' };
    expect(KNOWLEDGE_SCHEMAS['memory.create'].safeParse(base).success).toBe(false);
    expect(KNOWLEDGE_SCHEMAS['memory.create'].safeParse({ ...base, scope: { level: 'global', refId: 'project-a' } }).success).toBe(false);
    expect(KNOWLEDGE_SCHEMAS['memory.create'].safeParse({ ...base, scope: { level: 'global' }, confidence: 2 }).success).toBe(false);
    expect(KNOWLEDGE_SCHEMAS['memory.search'].safeParse({ createdAfter: 'yesterday' }).success).toBe(false);
});
it('creates user-attributed assumptions and preserves provenance through explicit corrections', async () => {
    const initial = await service.memory.create({ layer: 'personal', scope: { level: 'global' }, content: 'Prefer morning meetings', veracity: 'inferred', confidence: 0.4 });
    expect(initial.provenance).toEqual({ method: 'user_stated', sourceId: 'user' });
    expect(initial.veracity).toBe('inferred');
    const corrected = await service.memory.correct({ id: initial.id, content: 'Prefer afternoon meetings' });
    expect(corrected.veracity).toBe('observed_fact');
    expect((await service.memory.search({ text: 'afternoon' }))[0]?.memory.id).toBe(corrected.id);
    expect(await service.memory.search({ text: 'morning' })).toEqual([]);
    const old = await service.memory.inspect(initial.id);
    expect(old.memory.supersededBy).toBe(corrected.id);
    expect(old.events.some((event) => event.relatedMemoryId === corrected.id)).toBe(true);
    expect((await service.memory.inspect(corrected.id)).events.some((event) => event.kind === 'user_correction' && event.sourceId === 'user')).toBe(true);
});
it('deletes exactly the requested memory, its provenance and its keyword index', async () => {
    const a = await service.memory.create({ layer: 'personal', scope: { level: 'global' }, content: 'unique kiwi' });
    const b = await service.memory.create({ layer: 'personal', scope: { level: 'global' }, content: 'unique pear' });
    expect(await service.memory.delete(a.id)).toEqual({ deleted: true, id: a.id });
    expect(await service.memory.search({ text: 'kiwi' })).toEqual([]);
    expect(store.db.prepare('SELECT id FROM memory_provenance_events WHERE memory_id = ?').all(a.id)).toEqual([]);
    expect((await memory.inspect(b.id)).id).toBe(b.id);
    await expect(service.memory.delete(a.id)).rejects.toThrow(/not found/i);
});
it('lists, corrects and deletes context while retaining visible user provenance', () => {
    const item = service.context.create({ content: 'Deadline maybe Friday', scope: { level: 'project', refId: 'workspace-a' }, veracity: 'inferred' });
    expect(service.context.list({ scope: item.scope }).map((row) => row.id)).toEqual([item.id]);
    expect(service.context.list({ scope: { level: 'project', refId: 'workspace-b' } })).toEqual([]);
    const corrected = service.context.correct({ id: item.id, content: 'Deadline Monday' });
    expect(corrected.veracity).toBe('observed_fact');
    expect(corrected.provenance).toContainEqual({ method: 'user_stated', sourceId: 'user' });
    expect(service.context.delete(item.id).deleted).toBe(true);
    expect(() => service.context.inspect(item.id)).toThrow(/not found/i);
});
describe('task retrieval scope isolation', () => {
    it('deletes a project locally during an outage, preserving remote cleanup and other projects', async () => {
        const project = new WorkspaceService(store).create({ name: 'Delete', rootPath: '/tmp' });
        const m = await memory.create({ layer: 'project', scope: { level: 'project', refId: project.id }, content: 'erase project content' });
        const keep = await memory.create({ layer: 'project', scope: { level: 'project', refId: 'other' }, content: 'retain other project' });
        mock.setOffline(true);
        const result = await deleteProject({ store, audit: new AuditLog(store), flushMemories: () => memory.synchronize() }, project.id);
        expect(result.memoryCleanupPending).toBe(true);
        expect(store.db.prepare('SELECT id FROM workspaces WHERE id=?').get(project.id)).toBeUndefined();
        expect(store.db.prepare('SELECT id FROM memories WHERE id=?').get(m.id)).toBeUndefined();
        mock.setOffline(false);
        await memory.synchronize();
        expect(mock.records.size).toBe(1);
        expect((await memory.inspect(keep.id)).content).toBe('retain other project');
    });
    it('resolves memory content through Mem0 and rechecks persisted references after expiry and scope changes', async () => {
        const a = await memory.create({ layer: 'project', scope: { level: 'project', refId: 'workspace-a' }, content: 'remote project content' });
        const b = await memory.create({ layer: 'project', scope: { level: 'project', refId: 'workspace-b' }, content: 'private content' });
        const provider = new PersistentContextProvider(store, () => now, memory);
        const request = { workspaceId: 'workspace-a', taskId: 'task-a' };
        expect(await provider.resolveContent(request, [a.id, b.id])).toEqual([expect.objectContaining({ id: a.id, content: 'remote project content', trust: 'untrusted_reference_data' })]);
        await memory.expire(a.id);
        expect(await provider.resolveContent(request, [a.id, b.id])).toEqual([]);
    });

    it('preserves SQL context refs during a Mem0 outage', async () => {
        const c = context.create({ scope: { level: 'project', refId: 'workspace-a' }, content: 'active work state' });
        await memory.create({ layer: 'project', scope: { level: 'project', refId: 'workspace-a' }, content: 'remote' });
        mock.setOffline(true);
        const provider = new PersistentContextProvider(store, () => now, memory);
        expect(await provider.retrieveContext({ workspaceId: 'workspace-a', taskId: 'task-a', objective: 'help' })).toEqual({ refs: [c.id] });
    });

    it('returns successful local knowledge deletion with pending Mem0 cleanup', async () => {
        const m = await service.memory.create({ layer: 'personal', scope: { level: 'global' }, content: 'erase' });
        mock.setOffline(true);
        expect(await service.memory.delete(m.id)).toEqual({ id: m.id, deleted: true, memoryCleanupPending: true });
    });
    it('keeps personal memory out of projects and includes only matching workspace/task memory', async () => {
        const allowed: string[] = [];
        const personal: string[] = [];
        let allowedMemory = '';
        for (const scope of [{ level: 'global' }, { level: 'project', refId: 'workspace-a' }, { level: 'task', refId: 'task-a' }] as const) {
            allowed.push(context.create({ scope, content: 'Inferred context', veracity: 'inferred', provenance: [{ method: 'agent_output', sourceId: 'agent' }] }).id);
            const id = (await memory.create({ scope, content: 'Inferred memory', layer: scope.level === 'global' ? 'personal' : scope.level, veracity: 'inferred' })).id;
            if (scope.level === 'global') personal.push(id); else { allowed.push(id); allowedMemory ||= id; }
        }
        for (const scope of [{ level: 'project', refId: 'workspace-b' }, { level: 'task', refId: 'task-b' }, { level: 'workflow', refId: 'task-a' }, { level: 'source', refId: 'workspace-a' }] as const) {
            context.create({ scope, content: 'Private context' });
            await memory.create({ scope, content: 'Private memory', layer: 'project' });
        }
        await memory.create({ scope: { level: 'global' }, content: 'Expired', layer: 'personal', expiresAt: '2025-01-01T00:00:00Z' });
        const stale = await memory.create({ scope: { level: 'global' }, content: 'Stale', layer: 'personal' });
        const replacement = await memory.supersede(stale.id, { scope: { level: 'global' }, content: 'New', layer: 'personal' });
        personal.push(replacement.id);
        const result = await new PersistentContextProvider(store, () => now, memory).retrieveContext({ workspaceId: 'workspace-a', taskId: 'task-a', objective: 'Help me' });
        expect([...result.refs].sort()).toEqual([...allowed].sort());
        expect(result.refs).not.toEqual(expect.arrayContaining(personal));
        expect(context.inspect(allowed[0]!).veracity).toBe('inferred');
        expect((await memory.inspect(allowedMemory)).veracity).toBe('inferred');
    });
    it('applies limits after scope filtering so other workspaces cannot crowd out the current task', async () => {
        const wanted = await memory.create({ scope: { level: 'task', refId: 'task-a' }, content: 'Local knowledge', layer: 'task' });
        for (let i = 0; i < 110; i++)
            await memory.create({ scope: { level: 'project', refId: 'other' }, content: 'Other knowledge', layer: 'project' });
        const result = await new PersistentContextProvider(store, () => now, memory).retrieveContext({ workspaceId: 'workspace-a', taskId: 'task-a', objective: '' });
        expect(result.refs).toContain(wanted.id);
    });
    it('resolves an empty context bundle when the context store is unavailable', async () => {
        const provider = new PersistentContextProvider(store, Date.now, memory);
        store.close();
        await expect(provider.retrieveContext({ workspaceId: 'a', taskId: 'b', objective: '' })).resolves.toEqual({ refs: [] });
    });
});
