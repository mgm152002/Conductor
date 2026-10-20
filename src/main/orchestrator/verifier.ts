import { randomUUID } from 'node:crypto';
import type { AuditLog } from '../domain/audit-log';
import type { TaskStateMachine } from './state-machine';
import { isTerminal } from './state-machine';
import type { TaskEventEmitter } from './event-emitter';
import { noopTaskEventEmitter } from './event-emitter';
import type { Task, TaskState } from '@shared/domain';

// The VERIFYING step (Requirement 7.1–7.6; Property 3 — no false completion).
//
// This is the verification pass that decides whether a task that finished its
// steps may become COMPLETED. It runs ONLY once a task has reached VERIFYING
// (driven by the StepExecutor on RUNNING → VERIFYING, task 9.3) and it is the
// single authority on the VERIFYING → {COMPLETED | FAILED |
// RECOVERABLE_INTERRUPTION} decision.
//
// The load-bearing rule is Property 3: a task becomes COMPLETED only after a
// verification pass records EVERY acceptance criterion as satisfied, and the
// COMPLETED transition writes a VERIFIED checkpoint that references the
// verification outcome (Requirement 7.2, 7.6). An adapter session exit code of
// 0 is NEVER by itself sufficient to complete a task (Requirement 7.3) — this
// module never consults an exit code; it consults only the per-criterion
// evaluation produced here.
//
// What verify(task) does, in order:
//   1. Loads the task; a terminal task is a no-op, a non-VERIFYING task is
//      rejected (the StepExecutor is the only legitimate entry to VERIFYING).
//   2. Evaluates each acceptance criterion through the injectable
//      CriterionEvaluator seam, producing a per-criterion pass/fail outcome
//      (Requirement 7.1). Evaluation is bounded by a 300-second verification
//      timeout measured on an injectable monotonic clock (Requirement 7.5):
//      if the cumulative evaluation exceeds the budget BEFORE every criterion
//      has a recorded outcome, the pass did not finish.
//   3. Decides and transitions through the write-ahead TaskStateMachine:
//        * every criterion satisfied → VERIFYING → COMPLETED, writing a
//          VERIFIED checkpoint whose snapshot is the verification outcome
//          (Requirement 7.2, 7.6);
//        * one or more criteria not satisfied → VERIFYING → FAILED, recording
//          which criteria were not satisfied (Requirement 7.4);
//        * the pass exceeded the 300-second timeout before finishing →
//          VERIFYING → RECOVERABLE_INTERRUPTION, recording that verification
//          did not finish (Requirement 7.5).
//
// Every durable write goes through the TaskStateMachine's atomic transition, so
// legality and durability are never re-implemented here. The 300-second budget
// and the renderer emit are injectable seams (a {@link VerificationClock} and a
// {@link TaskEventEmitter}) so the whole path is exercised in tests without
// real wall-clock time and without Electron.

/** The configured verification timeout: 300 seconds (Requirement 7.5). */
export const VERIFICATION_TIMEOUT_MS = 300_000;

/**
 * Injectable monotonic clock for the verification timeout. `now()` returns
 * milliseconds from an arbitrary but monotonic origin; only differences matter.
 * The default reads the host monotonic timer; tests inject a fake that advances
 * deterministically so the 300-second budget is exercised with zero real delay.
 */
export interface VerificationClock {
  now(): number;
}

/** The real verification clock, backed by the host monotonic timer. */
export const systemVerificationClock: VerificationClock = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
};

/** The per-criterion outcome a {@link CriterionEvaluator} produces. */
export interface CriterionOutcome {
  /** The acceptance criterion text that was evaluated. */
  criterion: string;
  /** Its ordinal in the task's acceptance-criteria list (0-based). */
  index: number;
  /** Whether the criterion was satisfied by the task's results. */
  satisfied: boolean;
  /** Optional human-readable detail explaining the pass/fail. */
  detail?: string;
}

/** The input a {@link CriterionEvaluator} receives for one criterion. */
export interface EvaluateCriterionInput {
  task: Task;
  criterion: string;
  index: number;
}

/**
 * The pluggable seam that decides whether a single acceptance criterion is
 * satisfied by the task's results. This is where real verification logic
 * (LLM-graded checks, assertion runners, artifact inspection) lands later; the
 * Orchestrator depends only on this narrow contract so the VERIFYING decision
 * stays testable and deterministic.
 *
 * An evaluator MUST produce a pass/fail for the given criterion. It MAY be
 * async (verification can run adapters/tools). It MUST NOT consult an adapter
 * exit code as a sole success signal — doing so would violate Property 3.
 */
export type CriterionEvaluator = (
  input: EvaluateCriterionInput,
) => boolean | CriterionOutcome | Promise<boolean | CriterionOutcome>;

/**
 * The default evaluator used when none is injected. It is deliberately
 * CONSERVATIVE: with no real verification logic wired in, it cannot confirm any
 * criterion is satisfied, so it fails every criterion. This upholds Property 3
 * by refusing to complete a task on an unverified criterion — a task with
 * acceptance criteria never reaches COMPLETED through the placeholder. (A task
 * with zero criteria has nothing to fail and is handled by the all-satisfied
 * rule below.)
 */
export const conservativeCriterionEvaluator: CriterionEvaluator = ({
  criterion,
  index,
}): CriterionOutcome => ({
  criterion,
  index,
  satisfied: false,
  detail: 'no verification evidence (default evaluator cannot confirm)',
});

/** How a verification pass resolved, for the caller/tests. */
export type VerifyOutcome =
  | 'completed' // every criterion satisfied → COMPLETED (verified checkpoint)
  | 'failed' // one or more criteria not satisfied → FAILED
  | 'timed_out' // the 300s budget was exceeded before finishing → RECOVERABLE_INTERRUPTION
  | 'not_verifying' // the task was not in VERIFYING (nothing done)
  | 'already_terminal'; // the task was terminal when verification was asked to run

/** The structured result of a verification pass. */
export interface VerifyResult {
  outcome: VerifyOutcome;
  state: TaskState;
  /** Per-criterion outcomes recorded during this pass (may be partial on timeout). */
  criteria: CriterionOutcome[];
  /** The criteria that were not satisfied (empty on completion). */
  failed: CriterionOutcome[];
  /** The id of the VERIFIED checkpoint written on completion, if any. */
  verifiedCheckpointId?: string;
}

export interface VerifierOptions {
  /** The per-criterion evaluator. Defaults to the conservative evaluator. */
  evaluator?: CriterionEvaluator;
  /** The monotonic clock driving the 300s timeout. Defaults to the host timer. */
  clock?: VerificationClock;
  /** Renderer event-emit seam. Defaults to a no-op (headless). */
  emitter?: TaskEventEmitter;
  /** The verification timeout in ms. Defaults to 300_000 (Requirement 7.5). */
  timeoutMs?: number;
}

/**
 * Drives the VERIFYING pass for a single task. Constructed once per orchestrator
 * and invoked on a task the StepExecutor has already moved to VERIFYING.
 */
export class Verifier {
  private readonly evaluator: CriterionEvaluator;
  private readonly clock: VerificationClock;
  private readonly emitter: TaskEventEmitter;
  private readonly timeoutMs: number;

  constructor(
    private readonly stateMachine: TaskStateMachine,
    private readonly audit: AuditLog,
    options: VerifierOptions = {},
  ) {
    this.evaluator = options.evaluator ?? conservativeCriterionEvaluator;
    this.clock = options.clock ?? systemVerificationClock;
    this.emitter = options.emitter ?? noopTaskEventEmitter;
    this.timeoutMs = options.timeoutMs ?? VERIFICATION_TIMEOUT_MS;
  }

  /**
   * Run the verification pass (Requirement 7.1–7.6; Property 3).
   *
   * The task must be in VERIFYING. Evaluates every acceptance criterion, then
   * transitions through the write-ahead TaskStateMachine to exactly one of
   * COMPLETED (all satisfied — with a VERIFIED checkpoint referencing the
   * outcome), FAILED (any unsatisfied), or RECOVERABLE_INTERRUPTION (the 300s
   * budget was exceeded before the pass finished). Never consults an adapter
   * exit code.
   */
  async verify(taskId: string): Promise<VerifyResult> {
    const task = this.stateMachine.getTask(taskId);
    if (task === undefined) {
      throw new Error(`Task ${taskId} not found`);
    }
    if (isTerminal(task.state)) {
      return {
        outcome: 'already_terminal',
        state: task.state,
        criteria: [],
        failed: [],
      };
    }
    if (task.state !== 'VERIFYING') {
      // VERIFYING is reached only via the StepExecutor (RUNNING → VERIFYING).
      // Verifying a task that is not there is a programming error: do nothing
      // durable and report it so the caller can surface it.
      return {
        outcome: 'not_verifying',
        state: task.state,
        criteria: [],
        failed: [],
      };
    }

    const criteria = task.acceptanceCriteria;
    const started = this.clock.now();
    const outcomes: CriterionOutcome[] = [];
    let timedOut = false;

    // Evaluate each criterion, producing a per-criterion pass/fail
    // (Requirement 7.1). The 300-second budget is checked BOTH before starting
    // a criterion and after it resolves: if the pass did not record an outcome
    // for every criterion within the budget, it did not finish
    // (Requirement 7.5). A pass with zero criteria cannot time out — there is
    // nothing to evaluate.
    for (let index = 0; index < criteria.length; index += 1) {
      if (this.clock.now() - started > this.timeoutMs) {
        timedOut = true;
        break;
      }

      const criterion = criteria[index]!;
      const evaluated = await this.evaluator({ task, criterion, index });
      const outcome: CriterionOutcome =
        typeof evaluated === 'boolean'
          ? { criterion, index, satisfied: evaluated }
          : evaluated;
      outcomes.push(outcome);

      if (this.clock.now() - started > this.timeoutMs) {
        // The evaluation itself overran the budget; the remaining criteria have
        // no recorded outcome, so the pass did not finish.
        if (outcomes.length < criteria.length) {
          timedOut = true;
        }
        break;
      }
    }

    if (timedOut) {
      return this.onTimeout(task, outcomes);
    }

    const failed = outcomes.filter((o) => !o.satisfied);
    if (failed.length > 0) {
      return this.onFailed(task, outcomes, failed);
    }

    // Every criterion satisfied (vacuously so when there are none): complete.
    return this.onCompleted(task, outcomes);
  }

  // ---- Terminal decisions (each a single write-ahead transition) ----

  /**
   * All criteria satisfied → VERIFYING → COMPLETED with a VERIFIED checkpoint
   * whose snapshot is the verification outcome (Requirement 7.2, 7.6). The
   * `verified: true` flag makes the state machine point the task's
   * `lastVerifiedCheckpointId` at this checkpoint.
   */
  private onCompleted(
    task: Task,
    outcomes: CriterionOutcome[],
  ): VerifyResult {
    const verificationId = randomUUID();
    const snapshot = {
      verificationId,
      verifiedAt: new Date().toISOString(),
      criteria: outcomes,
      allSatisfied: true,
    };

    const { checkpoint } = this.stateMachine.transition({
      taskId: task.id,
      to: 'COMPLETED',
      snapshot,
      verified: true,
      eventPayload: {
        reason: 'verified',
        verificationId,
        criteriaCount: outcomes.length,
      },
    });

    this.audit.append({
      actor: 'orchestrator',
      action: 'task.verify.completed',
      target: task.id,
      redactedPayload: {
        verificationId,
        verifiedCheckpointId: checkpoint.id,
        criteriaCount: outcomes.length,
      },
    });

    this.emitTaskUpdated(task.id);
    const after = this.stateMachine.getTask(task.id);
    return {
      outcome: 'completed',
      state: after?.state ?? 'COMPLETED',
      criteria: outcomes,
      failed: [],
      verifiedCheckpointId: checkpoint.id,
    };
  }

  /**
   * One or more criteria not satisfied → VERIFYING → FAILED, recording which
   * criteria were not satisfied (Requirement 7.4). The checkpoint is NOT
   * verified. (FAILED is the terminal choice here; a future recovery flow may
   * instead route through RECOVERABLE_INTERRUPTION, which Requirement 7.4 also
   * permits — both are modeled by the state machine.)
   */
  private onFailed(
    task: Task,
    outcomes: CriterionOutcome[],
    failed: CriterionOutcome[],
  ): VerifyResult {
    const snapshot = {
      verifiedAt: new Date().toISOString(),
      criteria: outcomes,
      allSatisfied: false,
      failedCriteria: failed,
    };

    this.stateMachine.transition({
      taskId: task.id,
      to: 'FAILED',
      snapshot,
      verified: false,
      eventPayload: {
        reason: 'not-verified',
        failedCriteria: failed.map((f) => ({
          index: f.index,
          criterion: f.criterion,
          ...(f.detail !== undefined ? { detail: f.detail } : {}),
        })),
      },
    });

    this.audit.append({
      actor: 'orchestrator',
      action: 'task.verify.failed',
      target: task.id,
      redactedPayload: {
        failedCriteria: failed.map((f) => ({
          index: f.index,
          criterion: f.criterion,
        })),
        criteriaCount: outcomes.length,
      },
    });

    this.emitTaskUpdated(task.id);
    const after = this.stateMachine.getTask(task.id);
    return {
      outcome: 'failed',
      state: after?.state ?? 'FAILED',
      criteria: outcomes,
      failed,
    };
  }

  /**
   * The verification pass exceeded the 300-second budget before recording an
   * outcome for every criterion → VERIFYING → RECOVERABLE_INTERRUPTION,
   * recording that verification did not finish (Requirement 7.5). The task is
   * NOT completed and NOT failed: a later pass can re-verify from here
   * (VERIFYING is reachable from RECOVERABLE_INTERRUPTION via `reverify`).
   */
  private onTimeout(
    task: Task,
    partial: CriterionOutcome[],
  ): VerifyResult {
    const snapshot = {
      verifiedAt: new Date().toISOString(),
      verificationFinished: false,
      timeoutMs: this.timeoutMs,
      evaluatedCount: partial.length,
      totalCriteria: task.acceptanceCriteria.length,
      criteria: partial,
    };

    this.stateMachine.transition({
      taskId: task.id,
      to: 'RECOVERABLE_INTERRUPTION',
      snapshot,
      verified: false,
      eventPayload: {
        reason: 'verification-timeout',
        verificationFinished: false,
        timeoutMs: this.timeoutMs,
        evaluatedCount: partial.length,
        totalCriteria: task.acceptanceCriteria.length,
      },
    });

    this.audit.append({
      actor: 'orchestrator',
      action: 'task.verify.timed_out',
      target: task.id,
      redactedPayload: {
        timeoutMs: this.timeoutMs,
        evaluatedCount: partial.length,
        totalCriteria: task.acceptanceCriteria.length,
      },
    });

    this.emitTaskUpdated(task.id);
    const after = this.stateMachine.getTask(task.id);
    return {
      outcome: 'timed_out',
      state: after?.state ?? 'RECOVERABLE_INTERRUPTION',
      criteria: partial,
      failed: partial.filter((o) => !o.satisfied),
    };
  }

  /** Emit a task.updated renderer event carrying the current task snapshot. */
  private emitTaskUpdated(taskId: string): void {
    const task = this.stateMachine.getTask(taskId);
    if (task === undefined) {
      return;
    }
    this.emitter.emit('task.updated', task);
  }
}
