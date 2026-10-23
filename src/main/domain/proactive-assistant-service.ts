import { randomUUID } from 'node:crypto';
import type { Store } from '../db/types';
import type {
  AutoExecuteRule,
  Suggestion,
  SuggestionAction,
  SuggestionGenerationResult,
  SuggestionStatus,
  SuggestionTrigger,
  SuggestionTriggerKind,
} from '@shared/domain';
import type { AuditLog } from './audit-log';
import type { PermissionService, PermissionSubject } from './permission-service';
import {
  noopSuggestionEmitter,
  type SuggestionEmitter,
} from '../orchestrator/suggestion-emitter';

// The Proactive_Assistant owns Requirement 19: suggest useful actions from
// authorized context the user stays in control of, auto-executing only
// explicitly configured low-risk actions within granted permissions.
//
//  - generate(): take an observed context signal (a deadline approaching, an
//    email awaiting reply, an interrupted task, a workflow due, a changed
//    document, or a repeatedly-failing step — 19.1) and produce a Suggestion
//    carrying the triggering context, the proposed action, and a human-readable
//    explanation. The signal's source must be authorized (19.6) or generation
//    is refused. The suggestion is surfaced non-blocking through the emitter
//    (19.2/19.3) regardless of disposition.
//
//    Disposition is decided here (19.4/19.5/19.7):
//      * If the action would create an external side effect, it is retained
//        unexecuted in `awaiting_authorization` until the user authorizes it or
//        dismisses it (19.7) — even if a rule and permissions would otherwise
//        allow it.
//      * Else if a matching, enabled AutoExecuteRule exists AND the subject
//        holds every permission the action requires, it is auto-executed and an
//        audit entry capturing the action, trigger, and timestamp is recorded
//        (19.4).
//      * Otherwise it is suggest-only; it is never executed without explicit
//        user confirmation (19.5).
//
//  - confirm(): the user confirms a suggest-only or authorized external
//    suggestion; the action executes now (19.5/19.7) and the audit trail
//    records it.
//  - dismiss(): the user dismisses a suggestion; it is never executed (19.5).
//  - addAutoExecuteRule()/removeAutoExecuteRule(): manage the explicit low-risk
//    auto-execute opt-ins (19.4). A rule is only ever added by the user; its
//    presence is necessary but never sufficient to auto-execute.
//
// The service never monitors sources on its own — it reacts to signals a caller
// (the ingestion worker, scheduler, orchestrator) hands it from sources the
// user has authorized; the `authorizedSources` seam is the enforcement point
// for the "limit monitoring to authorized sources" invariant (19.6).

/** Raised when a suggestion id does not exist. */
export class SuggestionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SuggestionNotFoundError';
  }
}

/**
 * Raised when a suggestion lifecycle transition is illegal — confirming or
 * dismissing a suggestion that is already resolved.
 */
export class SuggestionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SuggestionStateError';
  }
}

/** Raised when a signal is observed from a source the user has not authorized. */
export class UnauthorizedSourceError extends Error {
  readonly sourceId: string;

  constructor(sourceId: string) {
    super(
      `Source "${sourceId}" is not authorized for context monitoring; no suggestion will be generated`,
    );
    this.name = 'UnauthorizedSourceError';
    this.sourceId = sourceId;
  }
}

/**
 * A context signal observed from an authorized source, handed to
 * {@link ProactiveAssistant.generate}. This is the injectable, mockable seam
 * the suggestion is generated from: a caller (ingestion worker / scheduler /
 * orchestrator) produces these from sources the user has authorized; the
 * assistant never discovers signals on its own (Requirement 19.6).
 */
export interface ContextSignal {
  trigger: SuggestionTrigger;
  action: SuggestionAction;
  /** Why this action is suggested, in human-readable terms (Requirement 19.1). */
  explanation: string;
  /**
   * The subject whose permissions an auto-execution would be checked against
   * (Requirement 19.4). Defaults to the orchestrator-attributed subject when a
   * caller omits it; without a subject the action can never auto-execute.
   */
  subject?: PermissionSubject;
}

/**
 * The seam that actually performs a suggested action, invoked only for an
 * auto-executed or user-confirmed suggestion. It must never run for a
 * suggest-only or awaiting-authorization suggestion. Injected so execution is
 * testable without side effects; defaults to a no-op.
 */
export interface SuggestionExecutor {
  execute(suggestion: Suggestion): void | Promise<void>;
}

/** A no-op executor; the service defaults to this when none is injected. */
export const noopSuggestionExecutor: SuggestionExecutor = {
  execute(): void {
    // Intentionally does nothing.
  },
};

/**
 * The authorization check for context sources (Requirement 19.6). A caller
 * supplies the set/predicate of sources the user has authorized; the assistant
 * refuses to generate a suggestion from any other source. Defaults to allowing
 * nothing, so monitoring is opt-in: a deployment must explicitly authorize
 * sources.
 */
export interface AuthorizedSources {
  isAuthorized(sourceId: string): boolean;
}

/** An {@link AuthorizedSources} backed by an explicit, mutable allowlist. */
export class AllowlistAuthorizedSources implements AuthorizedSources {
  private readonly allowed: Set<string>;

  constructor(initial: Iterable<string> = []) {
    this.allowed = new Set(initial);
  }

  authorize(sourceId: string): void {
    this.allowed.add(sourceId);
  }

  revoke(sourceId: string): void {
    this.allowed.delete(sourceId);
  }

  isAuthorized(sourceId: string): boolean {
    return this.allowed.has(sourceId);
  }
}

interface SuggestionRow {
  id: string;
  trigger_kind: SuggestionTriggerKind;
  source_id: string;
  trigger: string;
  action: string;
  explanation: string;
  status: SuggestionStatus;
  created_at: string;
  resolved_at: string | null;
}

interface RuleRow {
  id: string;
  action_kind: string;
  subject_type: 'agent' | 'workflow';
  subject_id: string;
  enabled: number;
  created_at: string;
}

function rowToSuggestion(row: SuggestionRow): Suggestion {
  return {
    id: row.id,
    trigger: JSON.parse(row.trigger) as SuggestionTrigger,
    action: JSON.parse(row.action) as SuggestionAction,
    explanation: row.explanation,
    status: row.status,
    createdAt: row.created_at,
    ...(row.resolved_at !== null ? { resolvedAt: row.resolved_at } : {}),
  };
}

function rowToRule(row: RuleRow): AutoExecuteRule {
  return {
    id: row.id,
    actionKind: row.action_kind,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

export class ProactiveAssistant {
  constructor(
    private readonly store: Store,
    private readonly audit: AuditLog,
    private readonly permissions: PermissionService,
    private readonly authorizedSources: AuthorizedSources,
    private readonly emitter: SuggestionEmitter = noopSuggestionEmitter,
    private readonly executor: SuggestionExecutor = noopSuggestionExecutor,
    /** Clock seam so tests can control timestamps. */
    private readonly now: () => number = () => Date.now(),
  ) {}

  // ---- 19.1–19.7 generate ----

  /**
   * Generate a suggestion from an observed context signal (Requirement 19.1).
   * The signal's source must be authorized (Requirement 19.6) or an
   * {@link UnauthorizedSourceError} is thrown and nothing is persisted. The
   * suggestion always records the triggering context, the proposed action, and
   * the human-readable explanation, and is surfaced non-blocking through the
   * emitter (Requirement 19.2/19.3).
   *
   * Disposition:
   *  - External side effect → retained `awaiting_authorization`, never executed
   *    until authorization is granted or it is dismissed (Requirement 19.7).
   *  - Matching enabled rule + all required permissions held → `auto_executed`
   *    with an audit entry capturing action, trigger, and timestamp (19.4).
   *  - Otherwise → `suggested`, suggest-only, never executed without explicit
   *    confirmation (19.5).
   */
  async generate(signal: ContextSignal): Promise<SuggestionGenerationResult> {
    const sourceId = signal.trigger.sourceId;
    if (!this.authorizedSources.isAuthorized(sourceId)) {
      // Limit monitoring to authorized sources (Requirement 19.6): refuse and
      // record the refusal; no suggestion is created.
      this.audit.append({
        actor: 'orchestrator',
        action: 'proactive.source_unauthorized',
        target: sourceId,
        redactedPayload: {
          triggerKind: signal.trigger.kind,
          sourceId,
        },
      });
      throw new UnauthorizedSourceError(sourceId);
    }

    const status = this.decideDisposition(signal);
    const id = randomUUID();
    const createdAt = new Date(this.now()).toISOString();
    const resolvedAt =
      status === 'auto_executed' ? createdAt : null;

    this.store.db
      .prepare(
        `INSERT INTO suggestions
           (id, trigger_kind, source_id, trigger, action, explanation, status, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        signal.trigger.kind,
        sourceId,
        JSON.stringify(signal.trigger),
        JSON.stringify(signal.action),
        signal.explanation,
        status,
        createdAt,
        resolvedAt,
      );

    const suggestion = this.getSuggestion(id)!;

    this.audit.append({
      actor: 'orchestrator',
      action: 'proactive.suggestion_generated',
      target: id,
      redactedPayload: {
        triggerKind: signal.trigger.kind,
        sourceId,
        actionKind: signal.action.kind,
        externalSideEffect: signal.action.externalSideEffect,
        status,
      },
    });

    // Surface the suggestion non-blocking through the configured channel
    // regardless of disposition (Requirement 19.2/19.3); emit never throws back.
    this.emitter.emit(suggestion);

    const disposition =
      status === 'auto_executed'
        ? 'auto_executed'
        : status === 'awaiting_authorization'
          ? 'awaiting_authorization'
          : 'suggested';

    if (status === 'auto_executed') {
      // Record the audit entry capturing the action, trigger, and timestamp
      // BEFORE running it (Requirement 19.4), so the attempt is durable even if
      // the executor throws.
      this.audit.append({
        actor: 'orchestrator',
        action: 'proactive.auto_executed',
        target: id,
        redactedPayload: {
          actionKind: signal.action.kind,
          trigger: {
            kind: signal.trigger.kind,
            sourceId,
            summary: signal.trigger.summary,
          },
          timestamp: createdAt,
        },
      });
      await this.executor.execute(suggestion);
    }

    return { suggestion, disposition };
  }

  /**
   * Decide a signal's disposition without persisting. An action with an
   * external side effect is ALWAYS held for authorization (Requirement 19.7),
   * even if a rule and permissions would otherwise permit it — the external
   * side effect gate takes precedence. Auto-execution additionally requires a
   * subject, a matching enabled rule, and that the subject hold every
   * permission the action requires (Requirement 19.4). Anything else is
   * suggest-only (Requirement 19.5).
   */
  private decideDisposition(signal: ContextSignal): SuggestionStatus {
    if (signal.action.externalSideEffect) {
      return 'awaiting_authorization';
    }
    if (signal.subject === undefined) {
      return 'suggested';
    }
    if (!this.hasEnabledRule(signal.action.kind, signal.subject)) {
      return 'suggested';
    }
    const permitted = signal.action.permissionRequirements.every((req) =>
      this.permissions.allows(signal.subject!, req),
    );
    return permitted ? 'auto_executed' : 'suggested';
  }

  // ---- 19.5 / 19.7 confirm; 19.5 dismiss ----

  /**
   * The user confirms a suggest-only or awaiting-authorization suggestion; the
   * action executes now (Requirement 19.5/19.7). Only a `suggested` or
   * `awaiting_authorization` suggestion can be confirmed; a resolved one
   * throws. Records an audit entry and runs the executor.
   */
  async confirm(id: string): Promise<Suggestion> {
    const row = this.requireSuggestion(id);
    if (row.status !== 'suggested' && row.status !== 'awaiting_authorization') {
      throw new SuggestionStateError(
        `Suggestion ${id} is ${row.status}; only a pending suggestion can be confirmed`,
      );
    }
    const resolvedAt = new Date(this.now()).toISOString();
    this.setStatus(id, 'confirmed', resolvedAt);

    const suggestion = this.getSuggestion(id)!;
    this.audit.append({
      actor: 'user',
      action: 'proactive.confirmed',
      target: id,
      redactedPayload: {
        actionKind: suggestion.action.kind,
        trigger: {
          kind: suggestion.trigger.kind,
          sourceId: suggestion.trigger.sourceId,
        },
        timestamp: resolvedAt,
      },
    });
    await this.executor.execute(suggestion);
    return suggestion;
  }

  /**
   * The user dismisses a suggestion; it is never executed (Requirement 19.5).
   * Only a `suggested` or `awaiting_authorization` suggestion can be dismissed;
   * a resolved one throws.
   */
  dismiss(id: string): Suggestion {
    const row = this.requireSuggestion(id);
    if (row.status !== 'suggested' && row.status !== 'awaiting_authorization') {
      throw new SuggestionStateError(
        `Suggestion ${id} is ${row.status}; only a pending suggestion can be dismissed`,
      );
    }
    const resolvedAt = new Date(this.now()).toISOString();
    this.setStatus(id, 'dismissed', resolvedAt);
    this.audit.append({
      actor: 'user',
      action: 'proactive.dismissed',
      target: id,
      redactedPayload: { id },
    });
    return this.getSuggestion(id)!;
  }

  // ---- 19.4 auto-execute rule management ----

  /**
   * Add (or re-enable) an explicit low-risk auto-execute rule for an action
   * kind bound to a subject (Requirement 19.4). Idempotent per
   * (actionKind, subject): re-adding re-enables an existing rule rather than
   * duplicating it. Only the user adds a rule; its presence is necessary but
   * never sufficient to auto-execute.
   */
  addAutoExecuteRule(input: {
    actionKind: string;
    subject: PermissionSubject;
  }): AutoExecuteRule {
    const existing = this.store.db
      .prepare(
        `SELECT * FROM auto_execute_rules
         WHERE action_kind = ? AND subject_type = ? AND subject_id = ?`,
      )
      .get(
        input.actionKind,
        input.subject.type,
        input.subject.id,
      ) as RuleRow | undefined;

    if (existing !== undefined) {
      if (existing.enabled !== 1) {
        this.store.db
          .prepare('UPDATE auto_execute_rules SET enabled = 1 WHERE id = ?')
          .run(existing.id);
      }
      this.audit.append({
        actor: 'user',
        action: 'proactive.auto_execute_rule_enabled',
        target: existing.id,
        redactedPayload: {
          actionKind: input.actionKind,
          subject: input.subject,
        },
      });
      return this.getRule(existing.id)!;
    }

    const rule: AutoExecuteRule = {
      id: randomUUID(),
      actionKind: input.actionKind,
      subjectType: input.subject.type,
      subjectId: input.subject.id,
      enabled: true,
      createdAt: new Date(this.now()).toISOString(),
    };
    this.store.db
      .prepare(
        `INSERT INTO auto_execute_rules
           (id, action_kind, subject_type, subject_id, enabled, created_at)
         VALUES (?, ?, ?, ?, 1, ?)`,
      )
      .run(
        rule.id,
        rule.actionKind,
        rule.subjectType,
        rule.subjectId,
        rule.createdAt,
      );

    this.audit.append({
      actor: 'user',
      action: 'proactive.auto_execute_rule_added',
      target: rule.id,
      redactedPayload: { actionKind: input.actionKind, subject: input.subject },
    });
    return rule;
  }

  /**
   * Remove an auto-execute rule, so the action kind reverts to suggest-only for
   * the subject (Requirement 19.4/19.5). A no-op when no matching rule exists.
   */
  removeAutoExecuteRule(input: {
    actionKind: string;
    subject: PermissionSubject;
  }): void {
    const result = this.store.db
      .prepare(
        `DELETE FROM auto_execute_rules
         WHERE action_kind = ? AND subject_type = ? AND subject_id = ?`,
      )
      .run(input.actionKind, input.subject.type, input.subject.id);
    if (result.changes > 0) {
      this.audit.append({
        actor: 'user',
        action: 'proactive.auto_execute_rule_removed',
        redactedPayload: {
          actionKind: input.actionKind,
          subject: input.subject,
        },
      });
    }
  }

  /** The active auto-execute rules, newest first. */
  listAutoExecuteRules(): AutoExecuteRule[] {
    const rows = this.store.db
      .prepare(
        'SELECT * FROM auto_execute_rules ORDER BY created_at DESC, rowid DESC',
      )
      .all() as RuleRow[];
    return rows.map(rowToRule);
  }

  // ---- Reads ----

  getSuggestion(id: string): Suggestion | undefined {
    const row = this.store.db
      .prepare('SELECT * FROM suggestions WHERE id = ?')
      .get(id) as SuggestionRow | undefined;
    return row === undefined ? undefined : rowToSuggestion(row);
  }

  /** Suggestions filtered by status, newest first; all when omitted. */
  listSuggestions(status?: SuggestionStatus): Suggestion[] {
    if (status === undefined) {
      const rows = this.store.db
        .prepare('SELECT * FROM suggestions ORDER BY created_at DESC, rowid DESC')
        .all() as SuggestionRow[];
      return rows.map(rowToSuggestion);
    }
    const rows = this.store.db
      .prepare(
        `SELECT * FROM suggestions WHERE status = ?
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(status) as SuggestionRow[];
    return rows.map(rowToSuggestion);
  }

  // ---- Internals ----

  private hasEnabledRule(
    actionKind: string,
    subject: PermissionSubject,
  ): boolean {
    const row = this.store.db
      .prepare(
        `SELECT 1 FROM auto_execute_rules
         WHERE action_kind = ? AND subject_type = ? AND subject_id = ?
           AND enabled = 1
         LIMIT 1`,
      )
      .get(actionKind, subject.type, subject.id) as { 1: number } | undefined;
    return row !== undefined;
  }

  private getRule(id: string): AutoExecuteRule | undefined {
    const row = this.store.db
      .prepare('SELECT * FROM auto_execute_rules WHERE id = ?')
      .get(id) as RuleRow | undefined;
    return row === undefined ? undefined : rowToRule(row);
  }

  private requireSuggestion(id: string): SuggestionRow {
    const row = this.store.db
      .prepare('SELECT * FROM suggestions WHERE id = ?')
      .get(id) as SuggestionRow | undefined;
    if (row === undefined) {
      throw new SuggestionNotFoundError(`Suggestion ${id} not found`);
    }
    return row;
  }

  private setStatus(
    id: string,
    status: SuggestionStatus,
    resolvedAt: string,
  ): void {
    this.store.db
      .prepare('UPDATE suggestions SET status = ?, resolved_at = ? WHERE id = ?')
      .run(status, resolvedAt, id);
  }
}
