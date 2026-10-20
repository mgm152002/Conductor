import { randomUUID } from 'node:crypto';
import type { Store } from '../db/types';
import type {
  ContextItem,
  ContextScope,
  Provenance,
  ProvenanceMethod,
  Veracity,
} from '@shared/domain';

// The Context_Engine owns the structured, source-linked model of active work
// across the five Context_Scopes (global/project/task/workflow/source) from
// Requirement 12. Every item carries:
//
//   - a veracity classification (observed_fact | inferred | unverified_assumption),
//   - a confidence in the inclusive range [0.0, 1.0], and
//   - at least one provenance source linking it to where it came from.
//
// Two invariants are enforced here rather than left to callers:
//
//   1. A sourceless item (no identifiable provenance) is stored as an
//      unverified_assumption with confidence 0.0 (Requirement 12.3), regardless
//      of what the caller asked for.
//   2. A user correction reclassifies the item to observed_fact and records the
//      user as the correction's provenance (Requirement 12.5) — this is the
//      only path that elevates veracity to observed_fact, keeping Property 9
//      (no silent fact elevation) intact.
//
// inspect / correct / delete all reject a missing item with a not-found error
// and leave the stored model unchanged (Requirement 12.7).

export class ContextItemNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`Context item ${id} not found`);
    this.name = 'ContextItemNotFoundError';
  }
}

export class ContextValidationError extends Error {
  constructor(
    readonly field: 'content' | 'confidence' | 'scope',
    message: string,
  ) {
    super(message);
    this.name = 'ContextValidationError';
  }
}

interface ContextItemRow {
  id: string;
  scope_level: ContextScope['level'];
  scope_ref_id: string | null;
  content: string;
  veracity: Veracity;
  confidence: number;
  created_at: string;
  updated_at: string;
}

interface ProvenanceRow {
  id: string;
  item_id: string;
  source_id: string | null;
  derived_from: string | null;
  method: ProvenanceMethod;
  created_at: string;
}

function provenanceRowToProvenance(row: ProvenanceRow): Provenance {
  return {
    ...(row.source_id !== null ? { sourceId: row.source_id } : {}),
    ...(row.derived_from !== null
      ? { derivedFrom: JSON.parse(row.derived_from) as string[] }
      : {}),
    method: row.method,
  };
}

/**
 * A provenance source is "identifiable" when it names an origin we can trace:
 * it carries a sourceId, derivedFrom ids, or a method other than the default
 * `inferred`. A bare `{ method: 'inferred' }` with no linkage is treated as no
 * source for the purposes of Requirement 12.3.
 */
function isIdentifiable(p: Provenance): boolean {
  if (p.sourceId !== undefined && p.sourceId.trim() !== '') {
    return true;
  }
  if (p.derivedFrom !== undefined && p.derivedFrom.length > 0) {
    return true;
  }
  return p.method !== 'inferred';
}

export interface CreateContextItemInput {
  scope: ContextScope;
  content: string;
  /** Defaults to unverified_assumption; overridden to it when sourceless. */
  veracity?: Veracity;
  /** Defaults to 0.0; clamped to [0, 1]; forced to 0.0 when sourceless. */
  confidence?: number;
  /** Provenance sources. Sourceless (empty / unidentifiable) is allowed and
   * triggers the unverified_assumption + confidence 0.0 default. */
  provenance?: Provenance[];
}

const SCOPE_LEVELS: ReadonlySet<ContextScope['level']> = new Set([
  'global',
  'project',
  'task',
  'workflow',
  'source',
]);

export class ContextEngine {
  constructor(
    private readonly store: Store,
    /** Clock seam so tests can pin timestamps. */
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Create a context item. Validates content and scope, clamps confidence into
   * [0, 1], and applies the sourceless default from Requirement 12.3: an item
   * created without an identifiable provenance source is classified
   * unverified_assumption with confidence 0.0, and a single `inferred`
   * provenance marker is recorded so the item still satisfies the
   * "at least one provenance" shape. Returns the persisted item.
   */
  create(input: CreateContextItemInput): ContextItem {
    const content = input.content.trim();
    if (content === '') {
      throw new ContextValidationError('content', 'Content is required');
    }
    if (!SCOPE_LEVELS.has(input.scope.level)) {
      throw new ContextValidationError(
        'scope',
        `Unknown scope level: ${String(input.scope.level)}`,
      );
    }

    const supplied = (input.provenance ?? []).filter(isIdentifiable);
    const sourceless = supplied.length === 0;

    let veracity: Veracity;
    let confidence: number;
    let provenance: Provenance[];

    if (sourceless) {
      // Requirement 12.3 — no identifiable source: force the conservative
      // classification regardless of what the caller requested.
      veracity = 'unverified_assumption';
      confidence = 0.0;
      provenance = [{ method: 'inferred' }];
    } else {
      veracity = input.veracity ?? 'unverified_assumption';
      confidence = this.clampConfidence(input.confidence ?? 0.0);
      provenance = supplied;
    }

    const nowIso = new Date(this.now()).toISOString();
    const item: ContextItem = {
      id: randomUUID(),
      scope: {
        level: input.scope.level,
        ...(input.scope.refId !== undefined
          ? { refId: input.scope.refId }
          : {}),
      },
      content,
      veracity,
      confidence,
      provenance,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    this.store.transaction((tx) => {
      tx.db
        .prepare(
          `INSERT INTO context_items
             (id, scope_level, scope_ref_id, content, veracity, confidence, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          item.id,
          item.scope.level,
          item.scope.refId ?? null,
          item.content,
          item.veracity,
          item.confidence,
          item.createdAt,
          item.updatedAt,
        );
      this.insertProvenance(tx.db, item.id, item.provenance, nowIso);
    });

    return item;
  }

  /**
   * Inspect a context item, presenting its veracity classification, confidence
   * value, and provenance source list (Requirement 12.4). Rejects a missing
   * item with a not-found error (Requirement 12.7).
   */
  inspect(id: string): ContextItem {
    const item = this.find(id);
    if (item === undefined) {
      throw new ContextItemNotFoundError(id);
    }
    return item;
  }

  /** The item if it exists, otherwise undefined. */
  find(id: string): ContextItem | undefined {
    const row = this.store.db
      .prepare(
        `SELECT id, scope_level, scope_ref_id, content, veracity, confidence,
                created_at, updated_at
         FROM context_items WHERE id = ?`,
      )
      .get(id) as ContextItemRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    return this.rowToItem(row);
  }

  /** Items at a scope, newest-updated first (empty list when none). */
  listByScope(scope: ContextScope): ContextItem[] {
    const rows =
      scope.refId === undefined
        ? (this.store.db
            .prepare(
              `SELECT id, scope_level, scope_ref_id, content, veracity, confidence,
                      created_at, updated_at
               FROM context_items
               WHERE scope_level = ? AND scope_ref_id IS NULL
               ORDER BY updated_at DESC, rowid DESC`,
            )
            .all(scope.level) as ContextItemRow[])
        : (this.store.db
            .prepare(
              `SELECT id, scope_level, scope_ref_id, content, veracity, confidence,
                      created_at, updated_at
               FROM context_items
               WHERE scope_level = ? AND scope_ref_id = ?
               ORDER BY updated_at DESC, rowid DESC`,
            )
            .all(scope.level, scope.refId) as ContextItemRow[]);
    return rows.map((row) => this.rowToItem(row));
  }

  /**
   * Apply a user correction to a context item: update its content (when the
   * caller supplies new content), reclassify its veracity as observed_fact, and
   * record the correction's provenance as the user (Requirement 12.5). This is
   * the only path that elevates an item to observed_fact. Rejects a missing
   * item and leaves the model unchanged (Requirement 12.7).
   */
  correct(id: string, input: { content?: string; confidence?: number } = {}): ContextItem {
    const existing = this.find(id);
    if (existing === undefined) {
      throw new ContextItemNotFoundError(id);
    }

    let content = existing.content;
    if (input.content !== undefined) {
      const trimmed = input.content.trim();
      if (trimmed === '') {
        throw new ContextValidationError('content', 'Content is required');
      }
      content = trimmed;
    }
    // A user-corrected fact is observed; default its confidence to 1.0 unless
    // the caller pins one explicitly.
    const confidence = this.clampConfidence(input.confidence ?? 1.0);
    const nowIso = new Date(this.now()).toISOString();

    this.store.transaction((tx) => {
      tx.db
        .prepare(
          `UPDATE context_items
             SET content = ?, veracity = 'observed_fact', confidence = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(content, confidence, nowIso, id);
      // Record the user as the correction's provenance source.
      this.insertProvenance(
        tx.db,
        id,
        [{ method: 'user_stated', sourceId: 'user' }],
        nowIso,
      );
    });

    return this.inspect(id);
  }

  /**
   * Delete a context item, removing it (and its provenance, via ON DELETE
   * CASCADE) from the stored model (Requirement 12.6). Rejects a missing item
   * and leaves the model unchanged (Requirement 12.7).
   */
  delete(id: string): void {
    const exists =
      this.store.db
        .prepare('SELECT 1 FROM context_items WHERE id = ?')
        .get(id) !== undefined;
    if (!exists) {
      throw new ContextItemNotFoundError(id);
    }
    this.store.db.prepare('DELETE FROM context_items WHERE id = ?').run(id);
  }

  private clampConfidence(value: number): number {
    if (Number.isNaN(value)) {
      throw new ContextValidationError('confidence', 'Confidence must be a number');
    }
    if (value < 0) {
      return 0;
    }
    if (value > 1) {
      return 1;
    }
    return value;
  }

  private insertProvenance(
    db: Store['db'],
    itemId: string,
    provenance: Provenance[],
    createdAt: string,
  ): void {
    const stmt = db.prepare(
      `INSERT INTO context_provenance
         (id, item_id, source_id, derived_from, method, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const p of provenance) {
      stmt.run(
        randomUUID(),
        itemId,
        p.sourceId ?? null,
        p.derivedFrom !== undefined ? JSON.stringify(p.derivedFrom) : null,
        p.method,
        createdAt,
      );
    }
  }

  private rowToItem(row: ContextItemRow): ContextItem {
    const provRows = this.store.db
      .prepare(
        `SELECT id, item_id, source_id, derived_from, method, created_at
         FROM context_provenance WHERE item_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(row.id) as ProvenanceRow[];
    return {
      id: row.id,
      scope: {
        level: row.scope_level,
        ...(row.scope_ref_id !== null ? { refId: row.scope_ref_id } : {}),
      },
      content: row.content,
      veracity: row.veracity,
      confidence: row.confidence,
      provenance: provRows.map(provenanceRowToProvenance),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
