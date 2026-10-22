import { mockMem0 } from '../helpers/mem0';
let mock: ReturnType<typeof mockMem0>;
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fc } from '../helpers/fast-check';
import { SqliteStore } from '@main/db/store';
import { MemoryEngine, MemoryNotFoundError, MemoryValidationError, type CreateMemoryInput, } from '@main/domain/memory-engine';
import type { ContextScope, MemoryLayer, Provenance, Veracity } from '@shared/domain';
// Unit + property tests for Requirement 13 (Persistent Memory Engine):
//   13.1 — every memory lives in exactly one of the four layers
//   13.2 — creation records provenance (source id, timestamp, veracity, layer)
//   13.3 — search by keyword (FTS5), layer, project, source, time; ranked desc
//   13.4 — a search with no matches returns an empty set without error
//   13.5 — contradiction/duplication supersedes with cross-referencing provenance
//   13.6 — a memory past its expiry is excluded from search
//   13.7 — inferred/unverified_assumption is never promoted to observed_fact
//          without an explicit user correction or verification event (Property 9)
//   13.8 — a promotion records the triggering event (source id + timestamp)
let workDir: string;
let store: SqliteStore;
let engine: MemoryEngine;
let clock: number;
const PROJECT_SCOPE: ContextScope = { level: 'project', refId: 'proj-1' };
const INGESTED: Provenance = { method: 'ingested', sourceId: 'doc-42' };
function base(overrides: Partial<CreateMemoryInput> = {}): CreateMemoryInput {
    return {
        layer: 'project',
        content: 'the build uses esbuild',
        scope: PROJECT_SCOPE,
        provenance: INGESTED,
        ...overrides,
    };
}
beforeEach(async () => {
    mock = mockMem0();
    workDir = mkdtempSync(join(tmpdir(), 'conductor-memory-'));
    store = new SqliteStore(join(workDir, 'app.db'));
    await store.migrate();
    clock = Date.parse('2025-01-01T00:00:00.000Z');
    engine = new MemoryEngine(store, () => clock, mock.client);
});
afterEach(() => {
    store.close();
    rmSync(workDir, { recursive: true, force: true });
});
describe('MemoryEngine.create', () => {
    it('stores a memory in exactly one layer with provenance and timestamp (13.1, 13.2)', async () => {
        const memory = await engine.create(base({ content: '  trimmed content  ' }));
        expect(memory.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(memory.layer).toBe('project');
        expect(memory.content).toBe('trimmed content');
        expect(memory.scope).toEqual(PROJECT_SCOPE);
        expect(memory.provenance).toEqual(INGESTED);
        expect(memory.createdAt).toBe('2025-01-01T00:00:00.000Z');
        expect(memory.supersededBy).toBeUndefined();
        // A 'created' provenance event is recorded (13.2).
        const events = engine.provenanceEvents(memory.id);
        expect(events).toHaveLength(1);
        expect(events[0]?.kind).toBe('created');
        expect(events[0]?.sourceId).toBe('doc-42');
        expect(events[0]?.createdAt).toBe('2025-01-01T00:00:00.000Z');
    });
    it('defaults veracity to unverified_assumption and confidence to 0.0', async () => {
        const memory = await engine.create(base());
        expect(memory.veracity).toBe('unverified_assumption');
        expect(memory.confidence).toBe(0.0);
    });
    it('honors observed_fact only for an explicit user statement', async () => {
        const userFact = await engine.create(base({
            veracity: 'observed_fact',
            provenance: { method: 'user_stated', sourceId: 'user' },
            confidence: 1,
        }));
        expect(userFact.veracity).toBe('observed_fact');
    });
    it('downgrades a non-user observed_fact request to inferred (Property 9)', async () => {
        const agentClaim = await engine.create(base({
            veracity: 'observed_fact',
            provenance: { method: 'agent_output', sourceId: 'agent-x' },
            confidence: 0.99,
        }));
        expect(agentClaim.veracity).toBe('inferred');
    });
    it('clamps confidence into [0, 1]', async () => {
        expect((await engine.create(base({ confidence: -3 }))).confidence).toBe(0);
        expect((await engine.create(base({ confidence: 9 }))).confidence).toBe(1);
    });
    it('rejects empty content and persists nothing', async () => {
        await expect(engine.create(base({ content: '   ' }))).rejects.toThrow(MemoryValidationError);
        expect(await engine.search({})).toHaveLength(0);
    });
    it('rejects an unknown layer', async () => {
        await expect(engine.create(base({ layer: 'nope' as unknown as MemoryLayer }))).rejects.toThrow(MemoryValidationError);
    });
    it('rejects a malformed expiresAt', async () => {
        await expect(engine.create(base({ expiresAt: 'not-a-date' }))).rejects.toThrow(MemoryValidationError);
    });
    it('supports all four layers (13.1)', async () => {
        const layers: MemoryLayer[] = ['personal', 'project', 'task', 'procedural'];
        for (const layer of layers) {
            const m = await engine.create(base({ layer, content: `${layer} note` }));
            expect(m.layer).toBe(layer);
            expect((await engine.search({ layer })).map((h) => h.memory.id)).toContain(m.id);
        }
    });
});
describe('MemoryEngine.search', () => {
    it('ranks keyword (FTS5) matches by relevance descending (13.3)', async () => {
        await engine.create(base({ content: 'deploy the service to production' }));
        const strong = await engine.create(base({ content: 'deploy deploy deploy pipeline deploy' }));
        await engine.create(base({ content: 'unrelated note about coffee' }));
        const hits = await engine.search({ text: 'deploy' });
        expect(hits.length).toBeGreaterThanOrEqual(2);
        // Scores are non-increasing.
        for (let i = 1; i < hits.length; i++) {
            expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
        }
        // The content densest in the term ranks first.
        expect(hits[0]?.memory.id).toBe(strong.id);
        // The unrelated note is not returned.
        expect(hits.map((h) => h.memory.content)).not.toContain('unrelated note about coffee');
    });
    it('returns an empty set without error when nothing matches (13.4)', async () => {
        await engine.create(base({ content: 'alpha beta gamma' }));
        expect(await engine.search({ text: 'zzzznotpresent' })).toEqual([]);
        expect(await engine.search({ layer: 'personal' })).toEqual([]);
    });
    it('filters by project, source, and time window (13.3)', async () => {
        const inProject = await engine.create(base({ scope: { level: 'project', refId: 'proj-A' } }));
        await engine.create(base({ scope: { level: 'project', refId: 'proj-B' } }));
        expect((await engine.search({ projectId: 'proj-A' })).map((h) => h.memory.id)).toEqual([inProject.id]);
        expect((await engine.search({ sourceId: 'doc-42' })).length).toBeGreaterThanOrEqual(1);
        expect(await engine.search({ sourceId: 'nope' })).toEqual([]);
        expect(await engine.search({ createdAfter: '2025-06-01T00:00:00.000Z' })).toEqual([]);
        expect((await engine.search({ createdBefore: '2025-06-01T00:00:00.000Z' })).length).toBeGreaterThanOrEqual(1);
    });
    it('treats FTS operator characters in the query as literal tokens', async () => {
        const m = await engine.create(base({ content: 'needs a code review now' }));
        // A query full of FTS5 syntax must not throw and should still match tokens.
        const hits = await engine.search({ text: 'review AND (code OR *)' });
        expect(hits.map((h) => h.memory.id)).toContain(m.id);
    });
});

describe('Mem0 durability and failure boundaries', () => {
    it('uses Mem0 semantic results without lexical overlap and rejects foreign results', async () => {
        const m = await engine.create(base({ content: 'Automobile maintenance instructions' }));
        const remote = [...mock.records.values()][0]!;
        mock.setSearchResults([{ ...remote, user_id: 'foreign-database', score: 1 }, { ...remote, score: 0.92 }]);
        expect(await engine.search({ text: 'car repairs' })).toEqual([{ memory: m, score: 0.92 }]);
        const call = mock.requests.find((r) => r.path === '/search')!;
        expect(call.body.filters.conductor_id).toEqual({ in: [m.id] });
    });
    it('stores content remotely and never reads a relational content copy', async () => {
        const m = await engine.create(base({ content: 'remote original' }));
        const row = store.db.prepare('SELECT content,mem0_id FROM memories WHERE id=?').get(m.id) as { content: string; mem0_id: string };
        expect(row.content).toBe('');
        const posted = mock.requests.find((r) => r.method === 'POST' && r.path === '/memories')!;
        expect(posted.body).toMatchObject({ infer: false, run_id: m.id, messages: [{ role: 'user', content: 'remote original' }], metadata: { conductor_id: m.id } });
        store.db.prepare("UPDATE memories SET content='must never be retrieved' WHERE id=?").run(m.id);
        expect((await engine.inspect(m.id)).content).toBe('remote original');
        mock.setOffline(true);
        await expect(engine.inspect(m.id)).rejects.toThrow(/unavailable/i);
        await expect(engine.search({ text: 'original' })).rejects.toThrow(/unavailable/i);
    });

    it('returns successful local deletion with pending cleanup during an outage, then drains on retry', async () => {
        const m = await engine.create(base());
        mock.setOffline(true);
        expect(await engine.delete(m.id)).toEqual({ memoryCleanupPending: true });
        expect(store.db.prepare('SELECT id FROM memories WHERE id=?').get(m.id)).toBeUndefined();
        expect(mock.records.size).toBe(1);
        expect(store.db.prepare('SELECT * FROM mem0_deletions').all()).toHaveLength(1);
        mock.setOffline(false);
        await engine.synchronize();
        expect(mock.records.size).toBe(0);
        expect(store.db.prepare('SELECT * FROM mem0_deletions').all()).toHaveLength(0);
    });

    it('synchronizes relational expiry changes and preserves authoritative trust', async () => {
        const m = await engine.create(base({ veracity: 'inferred' }));
        const remote = [...mock.records.values()][0]!;
        remote.metadata['conductor_veracity'] = 'observed_fact';
        expect((await engine.inspect(m.id)).veracity).toBe('inferred');
        store.db.prepare("UPDATE memories SET expires_at='2024-01-01T00:00:00Z' WHERE id=?").run(m.id);
        await engine.synchronize();
        expect(remote.metadata['conductor_expires_at']).toBe('2024-01-01T00:00:00Z');
        expect(await engine.search({})).toEqual([]);
    });

    it('rejects asynchronous network work inside a relational transaction', async () => {
        let operation!: ReturnType<MemoryEngine['create']>;
        store.transaction(() => { operation = engine.create(base()); });
        await expect(operation).rejects.toThrow(/transaction/i);
        expect(mock.requests).toHaveLength(0);
    });
});
describe('MemoryEngine.supersede (13.5)', () => {
    it('supersedes an existing memory and cross-references both ids', async () => {
        const old = await engine.create(base({ content: 'deadline is Friday' }));
        const next = await engine.supersede(old.id, base({
            content: 'deadline is Monday',
            provenance: { method: 'user_stated', sourceId: 'user' },
        }));
        // The superseded memory points at its replacement...
        expect((await engine.inspect(old.id)).supersededBy).toBe(next.id);
        // ...and both carry a cross-referencing provenance event.
        const oldEvents = engine.provenanceEvents(old.id);
        expect(oldEvents.some((e) => e.kind === 'superseded_by' && e.relatedMemoryId === next.id)).toBe(true);
        const newEvents = engine.provenanceEvents(next.id);
        expect(newEvents.some((e) => e.kind === 'supersedes' && e.relatedMemoryId === old.id)).toBe(true);
    });
    it('excludes a superseded memory from search (13.5)', async () => {
        const old = await engine.create(base({ content: 'xyzzy token here' }));
        await engine.supersede(old.id, base({ content: 'xyzzy token replacement' }));
        const ids = (await engine.search({ text: 'xyzzy' })).map((h) => h.memory.id);
        expect(ids).not.toContain(old.id);
    });
    it('rejects superseding a missing memory', async () => {
        await expect(engine.supersede('missing', base())).rejects.toThrow(MemoryNotFoundError);
    });
});
describe('MemoryEngine.expire (13.6)', () => {
    it('excludes a memory from search once it is expired', async () => {
        const m = await engine.create(base({ content: 'ephemeral widget note' }));
        expect((await engine.search({ text: 'ephemeral' })).map((h) => h.memory.id)).toContain(m.id);
        await engine.expire(m.id);
        expect(await engine.search({ text: 'ephemeral' })).toEqual([]);
    });
    it('excludes a memory whose stored expiry has passed (13.6)', async () => {
        const m = await engine.create(base({
            content: 'expiring soon marker',
            expiresAt: '2025-01-01T01:00:00.000Z',
        }));
        // Still live at creation time.
        expect((await engine.search({ text: 'expiring' })).map((h) => h.memory.id)).toContain(m.id);
        // Advance the clock past expiry.
        clock = Date.parse('2025-01-01T02:00:00.000Z');
        expect(await engine.search({ text: 'expiring' })).toEqual([]);
    });
    it('rejects expiring a missing memory', async () => {
        await expect(engine.expire('missing')).rejects.toThrow(MemoryNotFoundError);
    });
});
describe('MemoryEngine.promoteToFact (13.7, 13.8)', () => {
    it('promotes via a user correction and records the triggering event', async () => {
        const m = await engine.create(base({ veracity: 'inferred' }));
        clock = Date.parse('2025-02-02T00:00:00.000Z');
        const promoted = await engine.promoteToFact(m.id, {
            kind: 'user_correction',
            sourceId: 'user-7',
        });
        expect(promoted.veracity).toBe('observed_fact');
        expect(promoted.confidence).toBe(1.0);
        const events = engine.provenanceEvents(m.id);
        const promotion = events.find((e) => e.kind === 'user_correction');
        expect(promotion?.sourceId).toBe('user-7');
        expect(promotion?.createdAt).toBe('2025-02-02T00:00:00.000Z');
    });
    it('promotes via a verification event and records it (13.8)', async () => {
        const m = await engine.create(base({ veracity: 'unverified_assumption' }));
        const promoted = await engine.promoteToFact(m.id, {
            kind: 'verification',
            sourceId: 'verifier-ci',
        });
        expect(promoted.veracity).toBe('observed_fact');
        expect(engine.provenanceEvents(m.id).some((e) => e.kind === 'verification' && e.sourceId === 'verifier-ci')).toBe(true);
    });
    it('rejects a promotion with an empty source identifier', async () => {
        const m = await engine.create(base({ veracity: 'inferred' }));
        await expect(engine.promoteToFact(m.id, { kind: 'verification', sourceId: '  ' })).rejects.toThrow(MemoryValidationError);
        expect((await engine.inspect(m.id)).veracity).toBe('inferred');
    });
    it('rejects promoting a missing memory', async () => {
        await expect(engine.promoteToFact('missing', { kind: 'user_correction', sourceId: 'u' })).rejects.toThrow(MemoryNotFoundError);
    });
});
// --- Property 9: no silent fact elevation ------------------------------------
describe('Property 9 — no silent fact elevation (property-based)', () => {
    const provenanceArb: fc.Arbitrary<Provenance> = fc
        .constantFrom<Provenance['method']>('ingested', 'agent_output', 'user_stated', 'inferred')
        .chain((method) => fc.option(fc.string({ minLength: 1, maxLength: 8 }), { nil: undefined }).map((sourceId): Provenance => sourceId === undefined ? { method } : { method, sourceId }));
    const veracityArb: fc.Arbitrary<Veracity> = fc.constantFrom('observed_fact', 'inferred', 'unverified_assumption');
    it('never creates observed_fact except from an explicit user statement', async () => {
        await fc.assert(fc.asyncProperty(fc.string({ minLength: 1, maxLength: 40 }), veracityArb, provenanceArb, fc.double({ min: 0, max: 1, noNaN: true }), async (rawContent, veracity, provenance, confidence) => {
            const content = rawContent.trim() === '' ? 'x' : rawContent;
            const m = await engine.create({
                layer: 'personal',
                scope: { level: 'global' },
                content,
                veracity,
                provenance,
                confidence,
            });
            if (m.veracity === 'observed_fact') {
                // The ONLY way creation yields observed_fact is an explicit user
                // statement that asked for it.
                expect(provenance.method).toBe('user_stated');
                expect(veracity).toBe('observed_fact');
            }
            await engine.expire(m.id);
        }), { numRuns: 300 });
    });
    it('a non-fact memory reaches observed_fact only through promoteToFact', async () => {
        await fc.assert(fc.asyncProperty(fc.string({ minLength: 1, maxLength: 40 }), fc.constantFrom<Veracity>('inferred', 'unverified_assumption'), provenanceArb, fc.constantFrom<'user_correction' | 'verification'>('user_correction', 'verification'), async (rawContent, startVeracity, provenance, eventKind) => {
            const content = rawContent.trim() === '' ? 'x' : rawContent;
            const m = await engine.create({
                layer: 'task',
                scope: { level: 'task', refId: 't-1' },
                content,
                veracity: startVeracity,
                // force a non-user origin so it can't be created as a fact
                provenance: { ...provenance, method: 'agent_output' },
            });
            // It starts out NOT a fact.
            expect(m.veracity).not.toBe('observed_fact');
            // Promotion requires an explicit event, and records it.
            const promoted = await engine.promoteToFact(m.id, {
                kind: eventKind,
                sourceId: 'trigger-src',
            });
            expect(promoted.veracity).toBe('observed_fact');
            const events = engine.provenanceEvents(m.id);
            expect(events.some((e) => e.kind === eventKind && e.sourceId === 'trigger-src')).toBe(true);
            await engine.expire(m.id);
        }), { numRuns: 200 });
    });
});
