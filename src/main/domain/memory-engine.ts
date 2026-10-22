import { randomUUID } from 'node:crypto';
import type { Store } from '../db/types';
import { Mem0Client, Mem0Error, type Mem0Memory } from './mem0-client';
import type {
  ContextScope,
  MemoryLayer,
  MemoryProvenanceEvent,
  MemoryProvenanceEventKind,
  MemoryRecord,
  MemorySearchHit,
  MemorySearchQuery,
  Provenance,
  ProvenanceMethod,
  Veracity,
} from '@shared/domain';

// The Memory_Engine owns durable, searchable long-term knowledge across the
// four Memory_Layers (personal/project/task/procedural) from Requirement 13.
// Every memory carries:
//
//   - exactly one owning layer (13.1),
//   - an origin provenance (source id + method) and a creation timestamp (13.2),
//   - a veracity classification and a confidence in [0, 1].
//
// The engine enforces the invariants that keep long-term knowledge trustworthy
// rather than leaving them to callers:
//
//   1. Mem0 owns content and semantic ranking, with relational filtering by
//      layer/project/source/time, returns an empty set on no match, and never
//      returns a memory that is expired or superseded (13.3/13.4/13.6).
//   2. A new memory that contradicts or duplicates an existing one supersedes
//      it: the superseded memory gets a superseded_by pointer and both sides
//      get a provenance event referencing the other id (13.5).
//   3. A memory with veracity inferred/unverified_assumption is NEVER promoted
//      to observed_fact except through an explicit user correction or a
//      verification event, and every such promotion records the triggering
//      event (source id + timestamp) in the memory's provenance history
//      (13.7/13.8 — Property 9: no silent fact elevation).

export class MemoryNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`Memory ${id} not found`);
    this.name = 'MemoryNotFoundError';
  }
}

export class MemoryValidationError extends Error {
  constructor(
    readonly field: 'content' | 'confidence' | 'layer' | 'scope' | 'expiresAt',
    message: string,
  ) {
    super(message);
    this.name = 'MemoryValidationError';
  }
}

interface MemoryRow {
  id: string;
  layer: MemoryLayer;
  content: string;
  veracity: Veracity;
  confidence: number;
  source_id: string | null;
  derived_from: string | null;
  method: ProvenanceMethod;
  scope_level: ContextScope['level'];
  scope_ref_id: string | null;
  expires_at: string | null;
  superseded_by: string | null;
  created_at: string;
  mem0_id: string | null;
  mem0_dirty: number;
}

interface ProvenanceEventRow {
  id: string;
  memory_id: string;
  kind: MemoryProvenanceEventKind;
  related_memory_id: string | null;
  source_id: string | null;
  created_at: string;
}

const LAYERS: ReadonlySet<MemoryLayer> = new Set([
  'personal',
  'project',
  'task',
  'procedural',
]);

const SCOPE_LEVELS: ReadonlySet<ContextScope['level']> = new Set([
  'global',
  'project',
  'task',
  'workflow',
  'source',
]);

const DEFAULT_SEARCH_LIMIT = 50;
const operationQueues = new WeakMap<Store, Promise<unknown>>();

export interface CreateMemoryInput {
  layer: MemoryLayer;
  content: string;
  scope: ContextScope;
  /** Defaults to unverified_assumption. Never created as observed_fact unless
   * provenance.method is user_stated (an explicit user statement). */
  veracity?: Veracity;
  /** Defaults to 0.0; clamped to [0, 1]. */
  confidence?: number;
  /** Origin provenance. Defaults to `{ method: 'inferred' }` (sourceless). */
  provenance?: Provenance;
  /** Optional expiry (ISO-8601). When reached, the memory is excluded from
   * search (13.6). */
  expiresAt?: string;
}

/** The event that justifies promoting a memory to observed_fact (13.7/13.8). */
export type PromotionEvent =
  | { kind: 'user_correction'; sourceId: string }
  | { kind: 'verification'; sourceId: string };

export class MemoryEngine {
  constructor(
    private readonly store: Store,
    /** Clock seam so tests can pin timestamps. */
    private readonly now: () => number = () => Date.now(),
    private readonly mem0: Mem0Client = new Mem0Client(),
  ) {}

  private get userId(): string {
    return (this.store.db.prepare('SELECT user_id FROM mem0_namespace WHERE id=1').get() as { user_id: string }).user_id;
  }

  /** Whether the Mem0 service is reachable right now (never throws). */
  health(): Promise<{ reachable: boolean; detail?: string }> {
    return this.mem0.health();
  }

  /**
   * Best-effort recall for conversational context: returns the top matching
   * memories for `text`, or an empty set if Mem0 is unavailable. Unlike
   * `search`, this never throws, so a Mem0 outage degrades chat context
   * silently rather than failing a reply.
   */
  async recall(query: MemorySearchQuery, allowedIds?: readonly string[]): Promise<MemorySearchHit[]> {
    try {
      return await this.search(query, allowedIds);
    } catch {
      return [];
    }
  }

  /** Serialize cross-store operations; SQLite transactions remain synchronous. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.store.db.inTransaction) return Promise.reject(new Mem0Error('Mem0 operations cannot run inside a SQLite transaction'));
    const next = (operationQueues.get(this.store) ?? Promise.resolve()).then(work);
    operationQueues.set(this.store, next.catch(() => undefined));
    return next;
  }

  private row(id: string): MemoryRow | undefined {
    return this.store.db.prepare('SELECT * FROM memories WHERE id=?').get(id) as MemoryRow | undefined;
  }

  private metadata(row: MemoryRow): Record<string, unknown> {
    const { content: _content, mem0_id: _remote, mem0_dirty: _dirty, ...metadata } = row;
    return Object.fromEntries(Object.entries(metadata).map(([key, value]) => [`conductor_${key}`, value]));
  }

  private owned(remote: Mem0Memory, id: string): boolean {
    return remote.metadata?.['conductor_id'] === id && remote.user_id === this.userId && remote.run_id === id;
  }

  private async transfer(id: string): Promise<void> {
    const row = this.row(id);
    if (!row) return;
    let remoteId = row.mem0_id;
    if (remoteId === null) {
      // A previous POST may have succeeded even if its response was lost.
      const recovered = await this.mem0.list(this.userId, id);
      if (recovered.length > 1) throw new Mem0Error('Multiple Mem0 records for one memory; reconciliation required');
      const remote = recovered[0] ?? await this.mem0.add(this.userId, id, row.content, this.metadata(row));
      const confirmed = await this.mem0.get(remote.id);
      if (!this.owned(confirmed, id) || confirmed.memory !== row.content) throw new Mem0Error('Mem0 has not confirmed verbatim memory storage');
      remoteId = confirmed.id;
      // Link and clear only after a successful read-back. No network in this transaction.
      const result = this.store.db.prepare("UPDATE memories SET mem0_id=?, content='', mem0_dirty=1 WHERE id=?").run(remoteId, id);
      if (result.changes === 0) {
        this.store.db.prepare('INSERT OR REPLACE INTO mem0_deletions(memory_id,mem0_id) VALUES(?,?)').run(id, remoteId);
        return;
      }
    }
    const current = this.row(id);
    if (!current) return;
    await this.mem0.update(remoteId, this.metadata(current));
    const after = this.row(id);
    if (after && JSON.stringify(this.metadata(after)) === JSON.stringify(this.metadata(current))) {
      this.store.db.prepare('UPDATE memories SET mem0_dirty=0 WHERE id=?').run(id);
    }
  }

  private async drainDeletes(): Promise<void> {
    const rows = this.store.db.prepare('SELECT * FROM mem0_deletions').all() as { memory_id: string; mem0_id: string | null }[];
    for (const row of rows) {
      const remote = await this.mem0.list(this.userId, row.memory_id);
      const ids = new Set(remote.filter((r) => this.owned(r, row.memory_id)).map((r) => r.id));
      if (row.mem0_id !== null) ids.add(row.mem0_id);
      for (const id of ids) await this.mem0.delete(id);
      this.store.db.prepare('DELETE FROM mem0_deletions WHERE memory_id=?').run(row.memory_id);
    }
  }

  /** Resumable migration and deletion recovery, also used at startup. */
  synchronize(): Promise<void> {
    return this.exclusive(async () => {
      await this.drainDeletes();
      const rows = this.store.db.prepare('SELECT id FROM memories WHERE mem0_id IS NULL OR mem0_dirty=1').all() as { id: string }[];
      for (const row of rows) await this.transfer(row.id);
    });
  }

  /** Retry durable work while the app stays open; never delay startup. */
  startBackgroundSync(onError: (error: unknown) => void, intervalMs = 30_000): () => void {
    let stopped = false;
    let running = false;
    const tick = async (): Promise<void> => {
      if (stopped || running) return;
      running = true;
      try { await this.synchronize(); } catch (error) { if (!stopped) onError(error); }
      finally { running = false; }
    };
    const timer = setInterval(() => { void tick(); }, intervalMs);
    timer.unref();
    void tick();
    return () => { stopped = true; clearInterval(timer); };
  }

  /**
   * Create and persist a memory in exactly one layer, recording its origin
   * provenance and creation timestamp (13.1/13.2). veracity defaults to
   * unverified_assumption; a memory is created as observed_fact only when it is
   * an explicit user statement (provenance.method === 'user_stated'), so an
   * agent/ingested origin can never silently assert a fact (Property 9).
   */
  create(input: CreateMemoryInput): Promise<MemoryRecord> {
    return this.exclusive(() => this.createInternal(input));
  }

  private async createInternal(input: CreateMemoryInput, supersededId?: string): Promise<MemoryRecord> {
    const content = input.content.trim();
    if (content === '') {
      throw new MemoryValidationError('content', 'Content is required');
    }
    if (!LAYERS.has(input.layer)) {
      throw new MemoryValidationError(
        'layer',
        `Unknown memory layer: ${String(input.layer)}`,
      );
    }
    if (!SCOPE_LEVELS.has(input.scope.level)) {
      throw new MemoryValidationError(
        'scope',
        `Unknown scope level: ${String(input.scope.level)}`,
      );
    }
    if (input.scope.level === 'global' ? input.scope.refId !== undefined : !input.scope.refId?.trim()) {
      throw new MemoryValidationError('scope', 'Non-global scopes require an owner; global scope cannot have one');
    }
    if (input.expiresAt !== undefined && Number.isNaN(Date.parse(input.expiresAt))) {
      throw new MemoryValidationError('expiresAt', 'expiresAt must be ISO-8601');
    }

    const provenance: Provenance = input.provenance ?? { method: 'inferred' };
    const requested = input.veracity ?? 'unverified_assumption';
    // No silent fact elevation at creation: observed_fact is only honored when
    // the origin is an explicit user statement. Any other origin asking for
    // observed_fact is downgraded to inferred.
    const veracity: Veracity =
      requested === 'observed_fact' && provenance.method !== 'user_stated'
        ? 'inferred'
        : requested;
    const confidence = this.clampConfidence(input.confidence ?? 0.0);
    const nowIso = new Date(this.now()).toISOString();

    const record: MemoryRecord = {
      id: randomUUID(),
      layer: input.layer,
      content,
      veracity,
      confidence,
      provenance,
      scope: {
        level: input.scope.level,
        ...(input.scope.refId !== undefined ? { refId: input.scope.refId } : {}),
      },
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      createdAt: nowIso,
    };

    this.store.transaction((tx) => {
      tx.db
        .prepare(
          `INSERT INTO memories
             (id, layer, content, veracity, confidence, source_id, derived_from,
              method, scope_level, scope_ref_id, expires_at, superseded_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        )
        .run(
          record.id,
          record.layer,
          record.content,
          record.veracity,
          record.confidence,
          provenance.sourceId ?? null,
          provenance.derivedFrom !== undefined
            ? JSON.stringify(provenance.derivedFrom)
            : null,
          provenance.method,
          record.scope.level,
          record.scope.refId ?? null,
          record.expiresAt ?? null,
          record.createdAt,
        );
      this.appendEvent(tx.db, record.id, {
        kind: 'created',
        ...(provenance.sourceId !== undefined
          ? { sourceId: provenance.sourceId }
          : {}),
        createdAt: nowIso,
      });
      if (supersededId !== undefined) {
        tx.db.prepare('UPDATE memories SET superseded_by=?, mem0_dirty=1 WHERE id=?').run(record.id, supersededId);
        this.appendEvent(tx.db, supersededId, { kind: 'superseded_by', relatedMemoryId: record.id, createdAt: nowIso });
        this.appendEvent(tx.db, record.id, { kind: 'supersedes', relatedMemoryId: supersededId, createdAt: nowIso });
      }
    });
    await this.transfer(record.id);
    if (supersededId !== undefined) await this.transfer(supersededId);
    return record;
  }

  /** The memory if it exists, otherwise undefined. */
  async find(id: string): Promise<MemoryRecord | undefined> {
    await this.synchronize();
    const row = this.row(id);
    if (!row) return undefined;
    const remote = await this.mem0.get(row.mem0_id!);
    if (!this.owned(remote, id)) throw new Mem0Error('Mem0 memory ownership mismatch');
    const current = this.row(id);
    return current ? this.rowToRecord({ ...current, content: remote.memory }) : undefined;
  }

  /** Inspect a memory, including its provenance event history. */
  async inspect(id: string): Promise<MemoryRecord> {
    const record = await this.find(id);
    if (record === undefined) {
      throw new MemoryNotFoundError(id);
    }
    return record;
  }

  /** The append-only provenance event history for a memory (13.5/13.8). */
  provenanceEvents(id: string): MemoryProvenanceEvent[] {
    if (this.row(id) === undefined) {
      throw new MemoryNotFoundError(id);
    }
    const rows = this.store.db
      .prepare(
        `SELECT * FROM memory_provenance_events WHERE memory_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(id) as ProvenanceEventRow[];
    return rows.map((r) => this.eventRowToEvent(r));
  }

  /**
   * Record a new memory that supersedes an existing one because it corrects or
   * duplicates it (13.5). The superseded memory gets a superseded_by pointer
   * (so it drops out of search), and both memories get a provenance event
   * referencing the other id. Returns the new, superseding memory.
   */
  supersede(supersededId: string, input: CreateMemoryInput): Promise<MemoryRecord> {
    return this.exclusive(async () => {
      const old = this.row(supersededId);
      if (!old) throw new MemoryNotFoundError(supersededId);
      if (old.superseded_by !== null) throw new MemoryValidationError('scope', 'Memory has already been superseded');
      if (old.scope_level !== input.scope.level || old.scope_ref_id !== (input.scope.refId ?? null)) throw new MemoryValidationError('scope', 'Replacement must retain the same owner');
      return this.createInternal(input, supersededId);
    });
  }

  /**
   * Promote a memory's veracity to observed_fact. This is the ONLY path to
   * observed_fact for an inferred/unverified_assumption memory, and it requires
   * an explicit user-correction or verification event (13.7). The triggering
   * event is recorded with its source id and timestamp in the memory's
   * provenance history (13.8). A missing memory is rejected (model unchanged).
   */
  async promoteToFact(id: string, event: PromotionEvent): Promise<MemoryRecord> {
    await this.exclusive(async () => {
    const existing = this.row(id);
    if (existing === undefined) {
      throw new MemoryNotFoundError(id);
    }
    if (!['user_correction', 'verification'].includes(event.kind) || event.sourceId.trim() === '') {
      throw new MemoryValidationError(
        'scope',
        'A promotion event must carry a source identifier',
      );
    }
    const nowIso = new Date(this.now()).toISOString();
    this.store.transaction((tx) => {
      tx.db
        .prepare(
          `UPDATE memories SET veracity = 'observed_fact', confidence = 1.0, mem0_dirty=1 WHERE id = ?`,
        )
        .run(id);
      this.appendEvent(tx.db, id, {
        kind: event.kind,
        sourceId: event.sourceId,
        createdAt: nowIso,
      });
    });
    await this.transfer(id);
    });
    return this.inspect(id);
  }

  /** Mark a memory expired immediately so it drops out of search (13.6). */
  async expire(id: string): Promise<MemoryRecord> {
    await this.exclusive(async () => {
    const existing = this.row(id);
    if (existing === undefined) {
      throw new MemoryNotFoundError(id);
    }
    const nowIso = new Date(this.now()).toISOString();
    this.store.db
      .prepare(`UPDATE memories SET expires_at = ?, mem0_dirty=1 WHERE id = ?`)
      .run(nowIso, id);
    await this.transfer(id);
    });
    return this.inspect(id);
  }

  async delete(id: string): Promise<{ memoryCleanupPending?: boolean }> {
    return this.exclusive(async () => {
      if (!this.row(id) && !this.store.db.prepare('SELECT 1 FROM mem0_deletions WHERE memory_id=?').get(id)) throw new MemoryNotFoundError(id);
      this.store.db.prepare('DELETE FROM memories WHERE id=?').run(id);
      try { await this.drainDeletes(); }
      catch (error) { if (error instanceof Mem0Error) return { memoryCleanupPending: true }; throw error; }
      return {};
    });
  }

  /**
   * Mem0 ranks semantic matches; without a query, browse newest-first
   * (score derived from recency). Layer/project/source/time filters narrow the
   * set. Expired and superseded memories are always excluded (13.6). No match
   * returns an empty set without error (13.4). Results are score-descending.
   */
  async search(query: MemorySearchQuery, allowedIds?: readonly string[]): Promise<MemorySearchHit[]> {
    await this.synchronize();
    const nowIso = new Date(this.now()).toISOString();
    const limit =
      query.limit !== undefined && query.limit > 0
        ? Math.floor(query.limit)
        : DEFAULT_SEARCH_LIMIT;

    const filters: string[] = [
      'm.superseded_by IS NULL',
      '(m.expires_at IS NULL OR m.expires_at > @now)',
    ];
    const params: Record<string, unknown> = { now: nowIso };

    if (query.layer !== undefined) {
      filters.push('m.layer = @layer');
      params.layer = query.layer;
    }
    if (query.projectId !== undefined) {
      filters.push("m.scope_level = 'project' AND m.scope_ref_id = @projectId");
      params.projectId = query.projectId;
    }
    if (query.sourceId !== undefined) {
      filters.push('m.source_id = @sourceId');
      params.sourceId = query.sourceId;
    }
    if (query.createdAfter !== undefined) {
      filters.push('m.created_at >= @createdAfter');
      params.createdAfter = query.createdAfter;
    }
    if (query.createdBefore !== undefined) {
      filters.push('m.created_at <= @createdBefore');
      params.createdBefore = query.createdBefore;
    }

    const where = filters.join(' AND ');
    const text = query.text?.trim();

    const allowed = allowedIds === undefined ? undefined : new Set(allowedIds);
    const rows = (this.store.db.prepare(`SELECT m.* FROM memories m WHERE ${where} ORDER BY m.created_at DESC, m.rowid DESC`).all(params) as MemoryRow[])
      .filter((row) => allowed === undefined || allowed.has(row.id));
    const byRemote = new Map(rows.map((row) => [row.mem0_id, row]));
    const results: Mem0Memory[] = [];
    if (text) {
      // Filter on eligible IDs at Mem0 before top_k. Chunk to bound request size;
      // merge only Mem0 scores, never local content comparisons.
      for (let start = 0; start < rows.length; start += 200) {
        results.push(...await this.mem0.search(this.userId, rows.slice(start, start + 200).map((r) => r.id), text, Math.min(limit, 1000)));
      }
      results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    } else {
      for (const row of rows.slice(0, limit)) results.push(await this.mem0.get(row.mem0_id!));
    }
    const hits: MemorySearchHit[] = [];
    const seen = new Set<string>();
    for (const remote of results) {
      const selected = byRemote.get(remote.id);
      if (!selected || seen.has(selected.id) || !this.owned(remote, selected.id)) continue;
      const current = this.row(selected.id);
      if (!current || current.superseded_by !== null || (current.expires_at !== null && current.expires_at <= new Date(this.now()).toISOString())) continue;
      if (JSON.stringify(this.metadata(current)) !== JSON.stringify(this.metadata(selected))) continue;
      seen.add(selected.id);
      hits.push({ memory: this.rowToRecord({ ...current, content: remote.memory }), score: text ? remote.score ?? 0 : rows.length - hits.length });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  private clampConfidence(value: number): number {
    if (Number.isNaN(value)) {
      throw new MemoryValidationError('confidence', 'Confidence must be a number');
    }
    if (value < 0) {
      return 0;
    }
    if (value > 1) {
      return 1;
    }
    return value;
  }

  private appendEvent(
    db: Store['db'],
    memoryId: string,
    event: {
      kind: MemoryProvenanceEventKind;
      relatedMemoryId?: string;
      sourceId?: string;
      createdAt: string;
    },
  ): void {
    db.prepare(
      `INSERT INTO memory_provenance_events
         (id, memory_id, kind, related_memory_id, source_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      memoryId,
      event.kind,
      event.relatedMemoryId ?? null,
      event.sourceId ?? null,
      event.createdAt,
    );
  }

  private rowToRecord(row: MemoryRow): MemoryRecord {
    const provenance: Provenance = {
      ...(row.source_id !== null ? { sourceId: row.source_id } : {}),
      ...(row.derived_from !== null
        ? { derivedFrom: JSON.parse(row.derived_from) as string[] }
        : {}),
      method: row.method,
    };
    return {
      id: row.id,
      layer: row.layer,
      content: row.content,
      veracity: row.veracity,
      confidence: row.confidence,
      provenance,
      scope: {
        level: row.scope_level,
        ...(row.scope_ref_id !== null ? { refId: row.scope_ref_id } : {}),
      },
      ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {}),
      ...(row.superseded_by !== null ? { supersededBy: row.superseded_by } : {}),
      createdAt: row.created_at,
    };
  }

  private eventRowToEvent(row: ProvenanceEventRow): MemoryProvenanceEvent {
    return {
      id: row.id,
      memoryId: row.memory_id,
      kind: row.kind,
      ...(row.related_memory_id !== null
        ? { relatedMemoryId: row.related_memory_id }
        : {}),
      ...(row.source_id !== null ? { sourceId: row.source_id } : {}),
      createdAt: row.created_at,
    };
  }
}
