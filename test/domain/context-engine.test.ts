import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fc } from '../helpers/fast-check';
import { SqliteStore } from '@main/db/store';
import {
  ContextEngine,
  ContextItemNotFoundError,
  ContextValidationError,
} from '@main/domain/context-engine';
import type { ContextScope, Provenance } from '@shared/domain';

// Unit + property tests for Requirement 12 (Universal Context Engine):
//   12.1 — a structured, source-linked model across the five scopes
//   12.2 — veracity ∈ {observed_fact, inferred, unverified_assumption},
//          confidence ∈ [0, 1], and at least one provenance per item
//   12.3 — a sourceless item defaults to unverified_assumption, confidence 0.0
//   12.4 — inspect presents veracity, confidence, and provenance list
//   12.5 — correct reclassifies to observed_fact, records user provenance
//   12.6 — delete removes the item from the stored model
//   12.7 — correct/delete on a missing item is rejected, model unchanged

let workDir: string;
let store: SqliteStore;
let engine: ContextEngine;

const PROJECT_SCOPE: ContextScope = { level: 'project', refId: 'proj-1' };
const DOC_SOURCE: Provenance = { method: 'ingested', sourceId: 'doc-42' };

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'conductor-context-'));
  store = new SqliteStore(join(workDir, 'app.db'));
  await store.migrate();
  engine = new ContextEngine(store);
});

afterEach(() => {
  store.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe('ContextEngine.create', () => {
  it('stores a sourced item with its scope, veracity, confidence, and provenance', () => {
    const item = engine.create({
      scope: PROJECT_SCOPE,
      content: '  Ship M4 by Friday  ',
      veracity: 'inferred',
      confidence: 0.6,
      provenance: [DOC_SOURCE],
    });

    expect(item.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(item.scope).toEqual(PROJECT_SCOPE);
    expect(item.content).toBe('Ship M4 by Friday'); // trimmed
    expect(item.veracity).toBe('inferred');
    expect(item.confidence).toBeCloseTo(0.6);
    expect(item.provenance).toEqual([DOC_SOURCE]);
    expect(item.createdAt).toBe(item.updatedAt);
  });

  it('defaults a sourceless item to unverified_assumption with confidence 0.0 (12.3)', () => {
    const item = engine.create({
      scope: { level: 'global' },
      content: 'The user probably prefers dark mode',
      // caller asks for high-confidence fact, but there is no source
      veracity: 'observed_fact',
      confidence: 0.95,
    });

    expect(item.veracity).toBe('unverified_assumption');
    expect(item.confidence).toBe(0.0);
    // Still carries at least one provenance marker (12.2 shape).
    expect(item.provenance).toHaveLength(1);
    expect(item.provenance[0]?.method).toBe('inferred');
  });

  it('treats a bare inferred marker with no linkage as sourceless (12.3)', () => {
    const item = engine.create({
      scope: { level: 'task', refId: 't-1' },
      content: 'guess',
      veracity: 'inferred',
      confidence: 0.4,
      provenance: [{ method: 'inferred' }],
    });
    expect(item.veracity).toBe('unverified_assumption');
    expect(item.confidence).toBe(0.0);
  });

  it('keeps an item sourced when provenance is derived from other items', () => {
    const item = engine.create({
      scope: { level: 'task', refId: 't-1' },
      content: 'derived conclusion',
      veracity: 'inferred',
      confidence: 0.5,
      provenance: [{ method: 'inferred', derivedFrom: ['item-a', 'item-b'] }],
    });
    expect(item.veracity).toBe('inferred');
    expect(item.confidence).toBeCloseTo(0.5);
    expect(item.provenance[0]?.derivedFrom).toEqual(['item-a', 'item-b']);
  });

  it('clamps confidence into [0, 1] for a sourced item', () => {
    const low = engine.create({
      scope: { level: 'global' },
      content: 'a',
      confidence: -5,
      provenance: [DOC_SOURCE],
    });
    const high = engine.create({
      scope: { level: 'global' },
      content: 'b',
      confidence: 42,
      provenance: [DOC_SOURCE],
    });
    expect(low.confidence).toBe(0);
    expect(high.confidence).toBe(1);
  });

  it('rejects empty content and persists nothing', () => {
    expect(() =>
      engine.create({ scope: { level: 'global' }, content: '   ' }),
    ).toThrow(ContextValidationError);
    expect(engine.listByScope({ level: 'global' })).toHaveLength(0);
  });

  it('supports all five scope levels (12.1)', () => {
    const levels: ContextScope['level'][] = [
      'global',
      'project',
      'task',
      'workflow',
      'source',
    ];
    for (const level of levels) {
      const scope: ContextScope =
        level === 'global' ? { level } : { level, refId: `${level}-ref` };
      const item = engine.create({
        scope,
        content: `${level} item`,
        provenance: [DOC_SOURCE],
      });
      expect(item.scope.level).toBe(level);
      expect(engine.listByScope(scope).map((i) => i.id)).toContain(item.id);
    }
  });
});

describe('ContextEngine.inspect', () => {
  it('presents veracity, confidence, and the provenance source list (12.4)', () => {
    const created = engine.create({
      scope: PROJECT_SCOPE,
      content: 'fact',
      veracity: 'inferred',
      confidence: 0.7,
      provenance: [DOC_SOURCE, { method: 'agent_output', sourceId: 'agent-x' }],
    });

    const inspected = engine.inspect(created.id);
    expect(inspected.veracity).toBe('inferred');
    expect(inspected.confidence).toBeCloseTo(0.7);
    expect(inspected.provenance).toHaveLength(2);
    expect(inspected.provenance.map((p) => p.sourceId)).toEqual([
      'doc-42',
      'agent-x',
    ]);
  });

  it('rejects inspecting a missing item (12.7)', () => {
    expect(() => engine.inspect('nope')).toThrow(ContextItemNotFoundError);
  });
});

describe('ContextEngine.correct', () => {
  it('reclassifies to observed_fact and records user provenance (12.5)', () => {
    const created = engine.create({
      scope: PROJECT_SCOPE,
      content: 'The deadline is Friday',
      veracity: 'inferred',
      confidence: 0.5,
      provenance: [DOC_SOURCE],
    });

    const corrected = engine.correct(created.id, {
      content: 'The deadline is Monday',
    });

    expect(corrected.veracity).toBe('observed_fact');
    expect(corrected.content).toBe('The deadline is Monday');
    expect(corrected.confidence).toBe(1.0);
    // A user_stated provenance source was appended.
    const userSource = corrected.provenance.find(
      (p) => p.method === 'user_stated',
    );
    expect(userSource?.sourceId).toBe('user');
  });

  it('preserves prior provenance when appending the user correction', () => {
    const created = engine.create({
      scope: PROJECT_SCOPE,
      content: 'x',
      veracity: 'inferred',
      confidence: 0.3,
      provenance: [DOC_SOURCE],
    });
    const corrected = engine.correct(created.id);
    expect(corrected.content).toBe('x'); // unchanged when no new content given
    expect(corrected.provenance.map((p) => p.method)).toEqual([
      'ingested',
      'user_stated',
    ]);
  });

  it('rejects correcting a missing item and leaves the model unchanged (12.7)', () => {
    const created = engine.create({
      scope: PROJECT_SCOPE,
      content: 'keep me',
      provenance: [DOC_SOURCE],
    });
    expect(() => engine.correct('missing-id', { content: 'x' })).toThrow(
      ContextItemNotFoundError,
    );
    // Untouched.
    expect(engine.inspect(created.id).content).toBe('keep me');
  });
});

describe('ContextEngine.delete', () => {
  it('removes the item from the stored model (12.6)', () => {
    const created = engine.create({
      scope: PROJECT_SCOPE,
      content: 'temp',
      provenance: [DOC_SOURCE],
    });
    engine.delete(created.id);
    expect(engine.find(created.id)).toBeUndefined();
    expect(engine.listByScope(PROJECT_SCOPE)).toHaveLength(0);
  });

  it('cascades provenance rows on delete', () => {
    const created = engine.create({
      scope: PROJECT_SCOPE,
      content: 'temp',
      provenance: [DOC_SOURCE],
    });
    engine.delete(created.id);
    const orphans = store.db
      .prepare('SELECT COUNT(*) AS n FROM context_provenance WHERE item_id = ?')
      .get(created.id) as { n: number };
    expect(orphans.n).toBe(0);
  });

  it('rejects deleting a missing item and leaves the model unchanged (12.7)', () => {
    const created = engine.create({
      scope: PROJECT_SCOPE,
      content: 'keep me',
      provenance: [DOC_SOURCE],
    });
    expect(() => engine.delete('missing-id')).toThrow(
      ContextItemNotFoundError,
    );
    expect(engine.inspect(created.id).content).toBe('keep me');
  });
});

describe('ContextEngine invariants (property-based)', () => {
  const scopeArb: fc.Arbitrary<ContextScope> = fc
    .constantFrom<ContextScope['level']>(
      'global',
      'project',
      'task',
      'workflow',
      'source',
    )
    .chain((level) =>
      level === 'global'
        ? fc.constant<ContextScope>({ level })
        : fc
            .string({ minLength: 1, maxLength: 12 })
            .map<ContextScope>((refId) => ({ level, refId })),
    );

  it('every created item satisfies the stored-model invariants (12.2, 12.3)', () => {
    fc.assert(
      fc.property(
        scopeArb,
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.double({ min: -10, max: 10, noNaN: true }),
        fc.boolean(),
        (scope, rawContent, confidence, sourced) => {
          const content = rawContent.trim() === '' ? 'x' : rawContent;
          const provenance: Provenance[] = sourced
            ? [{ method: 'ingested', sourceId: 'src' }]
            : [];
          const item = engine.create({
            scope,
            content,
            veracity: 'inferred',
            confidence,
            provenance,
          });

          // veracity is one of the three classifications
          expect([
            'observed_fact',
            'inferred',
            'unverified_assumption',
          ]).toContain(item.veracity);
          // confidence is always in [0, 1]
          expect(item.confidence).toBeGreaterThanOrEqual(0);
          expect(item.confidence).toBeLessThanOrEqual(1);
          // at least one provenance source
          expect(item.provenance.length).toBeGreaterThanOrEqual(1);
          // sourceless => unverified_assumption + confidence 0.0 (12.3)
          if (!sourced) {
            expect(item.veracity).toBe('unverified_assumption');
            expect(item.confidence).toBe(0);
          }

          engine.delete(item.id);
        },
      ),
      { numRuns: 200 },
    );
  });
});
