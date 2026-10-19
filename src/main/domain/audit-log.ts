import { randomUUID } from 'node:crypto';
import type { Store } from '../db/types';
import type { AuditEvent } from '@shared/domain';
import { redact } from '../ipc/redaction';
import type { AuditSink } from '../ipc/audit-sink';

// The immutable audit log. Every privileged operation appends exactly one
// Audit_Event, with sensitive fields redacted before persistence so no secret
// value ever lands in a row (Property 6, defense in depth). The table has no
// UPDATE or DELETE code path anywhere — append is the only mutation — which is
// what makes the log immutable.
//
// AuditLog implements the narrow `AuditSink` seam the IPC router already
// depends on, so the router and this durable log are the same thing in
// production (the bootstrap composition root wires it in).

interface AuditEventRow {
  id: string;
  actor: string;
  action: string;
  target: string | null;
  redacted_payload: string;
  created_at: string;
}

function rowToEvent(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    actor: row.actor,
    action: row.action,
    ...(row.target !== null ? { target: row.target } : {}),
    redactedPayload: JSON.parse(row.redacted_payload) as unknown,
    createdAt: row.created_at,
  };
}

export interface AppendAuditInput {
  actor: string; // adapterId | 'orchestrator' | 'user'
  action: string;
  target?: string;
  /** Redacted here before persistence; callers need not pre-redact. */
  redactedPayload?: unknown;
}

export class AuditLog implements AuditSink {
  private readonly insertStmt;

  constructor(private readonly store: Store) {
    this.insertStmt = this.store.db.prepare(
      `INSERT INTO audit_events (id, actor, action, target, redacted_payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
  }

  /**
   * Append an immutable, redacted Audit_Event. The payload is passed through
   * {@link redact} so secret values never reach the row even if a caller hands
   * us an un-redacted object. Returns the persisted event.
   */
  append(input: AppendAuditInput): AuditEvent {
    const event: AuditEvent = {
      id: randomUUID(),
      actor: input.actor,
      action: input.action,
      ...(input.target !== undefined ? { target: input.target } : {}),
      redactedPayload: redact(input.redactedPayload ?? null),
      createdAt: new Date().toISOString(),
    };

    this.insertStmt.run(
      event.id,
      event.actor,
      event.action,
      event.target ?? null,
      JSON.stringify(event.redactedPayload ?? null),
      event.createdAt,
    );

    return event;
  }

  /** All events in append order (oldest first). Primarily for tests/inspection. */
  list(): AuditEvent[] {
    const rows = this.store.db
      .prepare(
        `SELECT id, actor, action, target, redacted_payload, created_at
         FROM audit_events ORDER BY created_at ASC, rowid ASC`,
      )
      .all() as AuditEventRow[];
    return rows.map(rowToEvent);
  }

  /** Bounded recent events for the desktop activity screen. */
  recent(limit = 100): AuditEvent[] {
    const rows = this.store.db.prepare('SELECT * FROM audit_events ORDER BY rowid DESC LIMIT ?').all(limit) as AuditEventRow[];
    return rows.map(rowToEvent);
  }

  /** Events for a single actor, oldest first. */
  listByActor(actor: string): AuditEvent[] {
    const rows = this.store.db
      .prepare(
        `SELECT id, actor, action, target, redacted_payload, created_at
         FROM audit_events WHERE actor = ? ORDER BY created_at ASC, rowid ASC`,
      )
      .all(actor) as AuditEventRow[];
    return rows.map(rowToEvent);
  }
}
