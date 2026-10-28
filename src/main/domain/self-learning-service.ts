import { randomUUID } from 'node:crypto';
import type { Store } from '../db/types';
import type {
  CandidateEvaluation,
  ImprovementCandidate,
  ImprovementProposal,
  ImprovementStatus,
  PerformanceBaseline,
  RecordTaskOutcomeInput,
  RegressionCheckResult,
  TaskOutcome,
  TaskOutcomeResult,
  TaskVerificationResult,
} from '@shared/domain';
import { MIN_IMPROVEMENT_EXAMPLES, MIN_REGRESSION_TASKS } from '@shared/domain';
import type { AuditLog } from './audit-log';

// The Self_Learning_Engine owns Requirement 18: improve from experience, under
// the user's approval, without ever changing core executable code (Property 10).
//
//  - record(): append a per-task outcome observation (18.1). Append-only, so
//    the evaluation always runs against an immutable history.
//  - evaluate(): classify a candidate as a demonstrated improvement ONLY when
//    it produces a measurable reduction in failure rate or duration across at
//    least MIN_IMPROVEMENT_EXAMPLES comparable prior examples; otherwise it is
//    classified as correlation and withheld — no proposal is created (18.2).
//  - A demonstrated candidate becomes exactly one ImprovementProposal of kind
//    skill | routing_rule | memory | workflow_version, in `proposed` status; no
//    adoption action is taken until the user approves/rejects (18.3).
//  - approve()/reject(): approve adopts (status `approved`); reject discards
//    (status `rejected`) and never adopts (18.4).
//  - checkRegression(): after adoption, if at least MIN_REGRESSION_TASKS
//    subsequent comparable tasks regress relative to the pre-adoption baseline,
//    roll the improvement back to its pre-adoption state and notify the user
//    via an audit event (18.5).
//
// Property 10 is structural: an ImprovementProposal's `kind` is one of exactly
// four learned-artifact kinds, enforced by the DB CHECK and the type; the
// engine has no path that writes executable code. `adoptCoreCode` does not
// exist and the kind union cannot name it.
//
// Persistence follows the established repository conventions (migration 9):
// append-only `task_outcomes` and the `improvement_proposals` lifecycle table,
// with JSON columns (verification_results, tool_usage, baseline, projected,
// payload) serialized by this service, exactly as the skills and workflow
// repositories own theirs.

/** Raised when an operation targets a proposal id that does not exist. */
export class ProposalNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProposalNotFoundError';
  }
}

/**
 * Raised when a proposal lifecycle transition is illegal — approving/rejecting
 * a proposal that is no longer `proposed`, or checking regression for a
 * proposal that was never adopted.
 */
export class ProposalStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProposalStateError';
  }
}

interface TaskOutcomeRow {
  id: string;
  task_id: string;
  comparability_key: string;
  result: TaskOutcomeResult;
  duration_ms: number;
  failure_count: number;
  retry_count: number;
  verification_results: string;
  tool_usage: string;
  user_feedback: string | null;
  improvement_id: string | null;
  recorded_at: string;
}

interface ProposalRow {
  id: string;
  comparability_key: string;
  kind: ImprovementProposal['kind'];
  summary: string;
  payload: string;
  status: ImprovementStatus;
  baseline: string;
  projected: string;
  created_at: string;
  resolved_at: string | null;
  rolled_back_at: string | null;
}

function rowToOutcome(row: TaskOutcomeRow): TaskOutcome {
  return {
    id: row.id,
    taskId: row.task_id,
    comparabilityKey: row.comparability_key,
    result: row.result,
    durationMs: row.duration_ms,
    failureCount: row.failure_count,
    retryCount: row.retry_count,
    verificationResults: JSON.parse(
      row.verification_results,
    ) as TaskVerificationResult[],
    toolUsage: JSON.parse(row.tool_usage) as string[],
    ...(row.user_feedback !== null ? { userFeedback: row.user_feedback } : {}),
    ...(row.improvement_id !== null
      ? { improvementId: row.improvement_id }
      : {}),
    recordedAt: row.recorded_at,
  };
}

function rowToProposal(row: ProposalRow): ImprovementProposal {
  return {
    id: row.id,
    comparabilityKey: row.comparability_key,
    kind: row.kind,
    summary: row.summary,
    payload: JSON.parse(row.payload) as unknown,
    status: row.status,
    baseline: JSON.parse(row.baseline) as PerformanceBaseline,
    projected: JSON.parse(row.projected) as PerformanceBaseline,
    createdAt: row.created_at,
    ...(row.resolved_at !== null ? { resolvedAt: row.resolved_at } : {}),
    ...(row.rolled_back_at !== null
      ? { rolledBackAt: row.rolled_back_at }
      : {}),
  };
}

/** Aggregate a set of outcomes into failure rate + mean duration. */
function summarize(outcomes: readonly TaskOutcome[]): PerformanceBaseline {
  const sampleSize = outcomes.length;
  if (sampleSize === 0) {
    return { sampleSize: 0, failureRate: 0, meanDurationMs: 0 };
  }
  const failures = outcomes.filter((o) => o.result === 'failure').length;
  const totalDuration = outcomes.reduce((sum, o) => sum + o.durationMs, 0);
  return {
    sampleSize,
    failureRate: failures / sampleSize,
    meanDurationMs: totalDuration / sampleSize,
  };
}

export class SelfLearningEngine {
  constructor(
    private readonly store: Store,
    private readonly audit: AuditLog,
    /** Clock seam so tests can control timestamps. */
    private readonly now: () => number = () => Date.now(),
  ) {}

  // ---- 18.1 record per-task outcome ----

  /**
   * Record a per-task outcome observation (Requirement 18.1): outcome,
   * duration, failure count, retry count, verification results, tool usage,
   * and any user feedback. Append-only — a new outcome is always a new row.
   */
  record(input: RecordTaskOutcomeInput): TaskOutcome {
    const id = randomUUID();
    const recordedAt = new Date(this.now()).toISOString();

    this.store.db
      .prepare(
        `INSERT INTO task_outcomes
           (id, task_id, comparability_key, result, duration_ms, failure_count,
            retry_count, verification_results, tool_usage, user_feedback,
            improvement_id, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.taskId,
        input.comparabilityKey,
        input.result,
        Math.max(0, Math.trunc(input.durationMs)),
        Math.max(0, Math.trunc(input.failureCount)),
        Math.max(0, Math.trunc(input.retryCount)),
        JSON.stringify(input.verificationResults ?? []),
        JSON.stringify(input.toolUsage ?? []),
        input.userFeedback ?? null,
        input.improvementId ?? null,
        recordedAt,
      );

    const outcome = this.getOutcome(id)!;
    this.audit.append({
      actor: 'orchestrator',
      action: 'task_outcome_recorded',
      target: input.taskId,
      redactedPayload: {
        comparabilityKey: input.comparabilityKey,
        result: input.result,
        durationMs: outcome.durationMs,
        failureCount: outcome.failureCount,
        retryCount: outcome.retryCount,
      },
    });
    return outcome;
  }

  // ---- 18.2 evaluate candidate; 18.3 propose on demonstrated ----

  /**
   * Evaluate a candidate against prior comparable task examples
   * (Requirement 18.2). The baseline is the aggregate of the comparable prior
   * outcomes; the candidate is classified as a demonstrated improvement only
   * when (a) there are at least MIN_IMPROVEMENT_EXAMPLES comparable prior
   * examples AND (b) its projected metrics show a measurable reduction in
   * failure rate OR mean duration. Otherwise it is classified as correlation
   * and withheld — no proposal is created or surfaced.
   *
   * The projected metrics are supplied by the caller (e.g. measured on a trial
   * of the candidate); the engine makes the classification decision. On a
   * demonstrated improvement, exactly one ImprovementProposal of the
   * candidate's kind is created in `proposed` status; no adoption happens here
   * (Requirement 18.3).
   */
  evaluate(
    candidate: ImprovementCandidate,
    projected: PerformanceBaseline,
  ): CandidateEvaluation {
    const priors = this.comparableOutcomes(candidate.comparabilityKey);
    const baseline = summarize(priors);

    if (priors.length < MIN_IMPROVEMENT_EXAMPLES) {
      this.audit.append({
        actor: 'orchestrator',
        action: 'improvement_withheld_correlation',
        redactedPayload: {
          comparabilityKey: candidate.comparabilityKey,
          kind: candidate.kind,
          reason: 'insufficient_examples',
          sampleSize: priors.length,
        },
      });
      return {
        classification: 'correlation',
        reason: 'insufficient_examples',
        baseline,
      };
    }

    const improvesFailureRate = projected.failureRate < baseline.failureRate;
    const improvesDuration = projected.meanDurationMs < baseline.meanDurationMs;
    if (!improvesFailureRate && !improvesDuration) {
      this.audit.append({
        actor: 'orchestrator',
        action: 'improvement_withheld_correlation',
        redactedPayload: {
          comparabilityKey: candidate.comparabilityKey,
          kind: candidate.kind,
          reason: 'no_measurable_improvement',
          sampleSize: priors.length,
        },
      });
      return {
        classification: 'correlation',
        reason: 'no_measurable_improvement',
        baseline,
      };
    }

    const proposal = this.createProposal(candidate, baseline, projected);
    return {
      classification: 'demonstrated',
      baseline,
      projected,
      proposal,
    };
  }

  // ---- 18.3/18.4 approve / reject ----

  /**
   * Approve a proposed improvement (Requirement 18.3): the only adoption
   * action, taken only on explicit user approval. Advances status to
   * `approved`. Rejects a proposal that is not currently `proposed`.
   */
  approve(proposalId: string): ImprovementProposal {
    const row = this.requireProposal(proposalId);
    if (row.status !== 'proposed') {
      throw new ProposalStateError(
        `Proposal ${proposalId} is ${row.status}, not proposed`,
      );
    }
    const resolvedAt = new Date(this.now()).toISOString();
    this.store.db
      .prepare(
        `UPDATE improvement_proposals SET status = 'approved', resolved_at = ?
         WHERE id = ?`,
      )
      .run(resolvedAt, proposalId);

    this.audit.append({
      actor: 'user',
      action: 'improvement_approved',
      target: proposalId,
      redactedPayload: { kind: row.kind, comparabilityKey: row.comparability_key },
    });
    return this.getProposal(proposalId)!;
  }

  /**
   * Reject a proposed improvement (Requirement 18.4): discard it and never
   * adopt it. Advances status to `rejected`. Rejects a proposal that is not
   * currently `proposed`.
   */
  reject(proposalId: string): ImprovementProposal {
    const row = this.requireProposal(proposalId);
    if (row.status !== 'proposed') {
      throw new ProposalStateError(
        `Proposal ${proposalId} is ${row.status}, not proposed`,
      );
    }
    const resolvedAt = new Date(this.now()).toISOString();
    this.store.db
      .prepare(
        `UPDATE improvement_proposals SET status = 'rejected', resolved_at = ?
         WHERE id = ?`,
      )
      .run(resolvedAt, proposalId);

    this.audit.append({
      actor: 'user',
      action: 'improvement_rejected',
      target: proposalId,
      redactedPayload: { kind: row.kind, comparabilityKey: row.comparability_key },
    });
    return this.getProposal(proposalId)!;
  }

  // ---- 18.5 regression tracking + rollback ----

  /**
   * Check an adopted improvement for a regression (Requirement 18.5). Looks at
   * the comparable tasks recorded AFTER the improvement was approved and
   * attributed to it. When at least MIN_REGRESSION_TASKS such tasks exist and
   * they regress — a higher failure rate OR a higher mean duration than the
   * pre-adoption baseline — the improvement is rolled back to its pre-adoption
   * state (status `rolled_back`) and the user is notified via an audit event.
   * Fewer than MIN_REGRESSION_TASKS subsequent tasks → `monitoring`; no
   * regression → `healthy`.
   */
  checkRegression(proposalId: string): RegressionCheckResult {
    const row = this.requireProposal(proposalId);
    if (row.status !== 'approved') {
      throw new ProposalStateError(
        `Proposal ${proposalId} is ${row.status}; only an approved improvement can regress`,
      );
    }

    const subsequent = this.outcomesForImprovement(proposalId);
    if (subsequent.length < MIN_REGRESSION_TASKS) {
      return {
        status: 'monitoring',
        improvementId: proposalId,
        observedCount: subsequent.length,
      };
    }

    const baseline = JSON.parse(row.baseline) as PerformanceBaseline;
    const observed = summarize(subsequent);
    const regressed =
      observed.failureRate > baseline.failureRate ||
      observed.meanDurationMs > baseline.meanDurationMs;

    if (!regressed) {
      return { status: 'healthy', improvementId: proposalId, observed };
    }

    const rolledBackAt = new Date(this.now()).toISOString();
    this.store.db
      .prepare(
        `UPDATE improvement_proposals SET status = 'rolled_back', rolled_back_at = ?
         WHERE id = ?`,
      )
      .run(rolledBackAt, proposalId);

    // Notify the user that a rollback occurred (Requirement 18.5).
    this.audit.append({
      actor: 'orchestrator',
      action: 'improvement_rolled_back',
      target: proposalId,
      redactedPayload: {
        kind: row.kind,
        comparabilityKey: row.comparability_key,
        baseline,
        observed,
        subsequentTasks: subsequent.length,
      },
    });

    return { status: 'rolled_back', improvementId: proposalId, baseline, observed };
  }

  /**
   * Purge old routing approvals: delete every `routing_rule` proposal that is
   * pending (`proposed`) or in effect (`approved`), so no previously approved
   * routing keeps steering tasks. Rejected / rolled-back routing history and
   * non-routing proposals are kept. Outcomes attributed to a purged rule are
   * detached (`improvement_id` cleared) rather than deleted. Audited as one
   * event carrying the removed ids.
   */
  purgeRoutingApprovals(actor = 'user'): { removed: number; removedIds: string[] } {
    const rows = this.store.db
      .prepare(`SELECT id FROM improvement_proposals WHERE kind = 'routing_rule' AND status IN ('proposed', 'approved') ORDER BY created_at ASC, rowid ASC`)
      .all() as { id: string }[];
    const removedIds = rows.map((r) => r.id);
    if (removedIds.length > 0) {
      this.store.transaction(({ db }) => {
        const placeholders = removedIds.map(() => '?').join(', ');
        db.prepare(`DELETE FROM improvement_proposals WHERE id IN (${placeholders})`).run(...removedIds);
        db.prepare(`UPDATE task_outcomes SET improvement_id = NULL WHERE improvement_id IN (${placeholders})`).run(...removedIds);
      });
      this.audit.append({
        actor,
        action: 'routing_approvals_purged',
        redactedPayload: { removed: removedIds.length, removedIds },
      });
    }
    return { removed: removedIds.length, removedIds };
  }

  // ---- Reads ----

  getOutcome(id: string): TaskOutcome | undefined {
    const row = this.store.db
      .prepare('SELECT * FROM task_outcomes WHERE id = ?')
      .get(id) as TaskOutcomeRow | undefined;
    return row === undefined ? undefined : rowToOutcome(row);
  }

  /** All recorded outcomes for a comparability key, oldest first. */
  comparableOutcomes(comparabilityKey: string): TaskOutcome[] {
    const rows = this.store.db
      .prepare(
        `SELECT * FROM task_outcomes WHERE comparability_key = ?
         ORDER BY recorded_at ASC, rowid ASC`,
      )
      .all(comparabilityKey) as TaskOutcomeRow[];
    return rows.map(rowToOutcome);
  }

  getProposal(id: string): ImprovementProposal | undefined {
    const row = this.store.db
      .prepare('SELECT * FROM improvement_proposals WHERE id = ?')
      .get(id) as ProposalRow | undefined;
    return row === undefined ? undefined : rowToProposal(row);
  }

  /** Proposals filtered by status, newest first; all proposals when omitted. */
  listProposals(status?: ImprovementStatus): ImprovementProposal[] {
    if (status === undefined) {
      const rows = this.store.db
        .prepare(
          'SELECT * FROM improvement_proposals ORDER BY created_at DESC, rowid DESC',
        )
        .all() as ProposalRow[];
      return rows.map(rowToProposal);
    }
    const rows = this.store.db
      .prepare(
        `SELECT * FROM improvement_proposals WHERE status = ?
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(status) as ProposalRow[];
    return rows.map(rowToProposal);
  }

  // ---- Internals ----

  private createProposal(
    candidate: ImprovementCandidate,
    baseline: PerformanceBaseline,
    projected: PerformanceBaseline,
  ): ImprovementProposal {
    const id = randomUUID();
    const createdAt = new Date(this.now()).toISOString();
    this.store.db
      .prepare(
        `INSERT INTO improvement_proposals
           (id, comparability_key, kind, summary, payload, status, baseline,
            projected, created_at, resolved_at, rolled_back_at)
         VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?, ?, NULL, NULL)`,
      )
      .run(
        id,
        candidate.comparabilityKey,
        candidate.kind,
        candidate.summary,
        JSON.stringify(candidate.payload ?? null),
        JSON.stringify(baseline),
        JSON.stringify(projected),
        createdAt,
      );

    this.audit.append({
      actor: 'orchestrator',
      action: 'improvement_proposed',
      target: id,
      redactedPayload: {
        comparabilityKey: candidate.comparabilityKey,
        kind: candidate.kind,
        summary: candidate.summary,
        baseline,
        projected,
      },
    });

    return this.getProposal(id)!;
  }

  private outcomesForImprovement(improvementId: string): TaskOutcome[] {
    const rows = this.store.db
      .prepare(
        `SELECT * FROM task_outcomes WHERE improvement_id = ?
         ORDER BY recorded_at ASC, rowid ASC`,
      )
      .all(improvementId) as TaskOutcomeRow[];
    return rows.map(rowToOutcome);
  }

  private requireProposal(id: string): ProposalRow {
    const row = this.store.db
      .prepare('SELECT * FROM improvement_proposals WHERE id = ?')
      .get(id) as ProposalRow | undefined;
    if (row === undefined) {
      throw new ProposalNotFoundError(`Proposal ${id} not found`);
    }
    return row;
  }
}
