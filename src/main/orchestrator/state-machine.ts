import { randomUUID } from 'node:crypto';
import type { Store } from '../db/types';
import type { AuditLog } from '../domain/audit-log';
import type { Checkpoint, Task, TaskEvent, TaskState } from '@shared/domain';

// The task state machine is the single authority on which transitions are
// legal and the only place a task's state changes durably. It encodes the
// design's legal Transition_Table verbatim and implements the write-ahead
// `transition` primitive: the transition event, the new task state, and a
// checkpoint are committed as one atomic DB unit BEFORE any side effect of the
// new state runs. If that commit fails the task stays in its pre-transition
// state, no side effect runs, and an Audit_Event records the failure
// (Requirement 4.2, 4.3; Property 1). Illegal transitions are rejected with
// the task left untouched and an Audit_Event appended (Requirement 4.4, 4.5;
// Property 5). COMPLETED, FAILED, and CANCELLED are terminal (Requirement 4.6).

/** The exactly 11 Task_States (Requirement 4.1). */
export const TASK_STATES = [
  'CREATED',
  'CONTEXT_LOADING',
  'PLANNING',
  'WAITING_FOR_APPROVAL',
  'RUNNING',
  'VERIFYING',
  'COMPLETED',
  'FAILED',
  'BLOCKED',
  'CANCELLED',
  'RECOVERABLE_INTERRUPTION',
] as const;

/** Terminal states a task can never leave (Requirement 4.6). */
export const TERMINAL_STATES = ['COMPLETED', 'FAILED', 'CANCELLED'] as const;

export type TerminalState = (typeof TERMINAL_STATES)[number];

/**
 * The legal Transition_Table, transcribed directly from the design's
 * "Orchestrator state machine — legal transition table". Each key is a source
 * state; the value is the set of target states reachable by exactly one legal
 * transition. A "—" cell in the design means the target is absent here. This
 * object is the single authority on legality; nothing else decides it.
 *
 * The three terminal states deliberately have empty target sets: no transition
 * may leave a terminal state.
 */
const TRANSITION_TABLE: Readonly<Record<TaskState, ReadonlySet<TaskState>>> = {
  CREATED: new Set<TaskState>([
    'CONTEXT_LOADING', // start
    'FAILED', // error
    'CANCELLED', // cancel
    'RECOVERABLE_INTERRUPTION', // boot-reconcile
  ]),
  CONTEXT_LOADING: new Set<TaskState>([
    'PLANNING', // ctx-loaded
    'FAILED', // error
    'BLOCKED', // missing-ctx
    'CANCELLED', // cancel
    'RECOVERABLE_INTERRUPTION', // boot-reconcile
  ]),
  PLANNING: new Set<TaskState>([
    'WAITING_FOR_APPROVAL', // needs-approval
    'RUNNING', // plan-ready (no approval)
    'FAILED', // error
    'BLOCKED', // unresolvable
    'CANCELLED', // cancel
    'RECOVERABLE_INTERRUPTION', // boot-reconcile
  ]),
  WAITING_FOR_APPROVAL: new Set<TaskState>([
    'PLANNING', // revise
    'RUNNING', // approved
    'CANCELLED', // denied / cancel
    'RECOVERABLE_INTERRUPTION', // boot-reconcile
  ]),
  RUNNING: new Set<TaskState>([
    'PLANNING', // replan
    'WAITING_FOR_APPROVAL', // needs-approval
    'VERIFYING', // steps-done
    'FAILED', // error
    'BLOCKED', // dependency-wait
    'CANCELLED', // cancel
    'RECOVERABLE_INTERRUPTION', // crash / boot-reconcile
  ]),
  VERIFYING: new Set<TaskState>([
    'RUNNING', // retry
    'COMPLETED', // verified
    'FAILED', // not-verified (terminal)
    'CANCELLED', // cancel
    'RECOVERABLE_INTERRUPTION', // boot-reconcile
  ]),
  RECOVERABLE_INTERRUPTION: new Set<TaskState>([
    'CONTEXT_LOADING', // reload
    'PLANNING', // replan
    'RUNNING', // resume
    'VERIFYING', // reverify
    'FAILED', // give-up
    'BLOCKED', // needs-decision
    'CANCELLED', // discard
  ]),
  BLOCKED: new Set<TaskState>([
    'PLANNING', // replan
    'WAITING_FOR_APPROVAL', // needs-approval
    'RUNNING', // unblocked
    'FAILED', // give-up
    'CANCELLED', // cancel
    'RECOVERABLE_INTERRUPTION', // boot-reconcile
  ]),
  // Terminal — no transition may leave these states (Requirement 4.6).
  COMPLETED: new Set<TaskState>(),
  FAILED: new Set<TaskState>(),
  CANCELLED: new Set<TaskState>(),
};

/** True when `state` is one of the three terminal states. */
export function isTerminal(state: TaskState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

/**
 * True iff a single transition from `from` to `to` is present in the
 * Transition_Table. This is the single authority consulted before any state
 * change (Requirement 4.4). A transition into the same state is never legal
 * unless the table lists it (none do).
 */
export function isLegalTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITION_TABLE[from].has(to);
}

/** Legal target states reachable from `from` in one transition. */
export function legalTargets(from: TaskState): TaskState[] {
  return [...TRANSITION_TABLE[from]];
}

/** Raised when a transition is rejected before any durable write occurs. */
export class IllegalTransitionError extends Error {
  constructor(
    readonly from: TaskState,
    readonly to: TaskState,
  ) {
    super(`Illegal task transition ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

/** Raised when the durable commit of a legal transition fails. */
export class TransitionCommitError extends Error {
  constructor(
    readonly from: TaskState,
    readonly to: TaskState,
    readonly reason: unknown,
  ) {
    const detail = reason instanceof Error ? reason.message : String(reason);
    super(`Durable commit of transition ${from} → ${to} failed: ${detail}`);
    this.name = 'TransitionCommitError';
  }
}

interface TaskRow {
  id: string;
  workspace_id: string;
  objective: string;
  acceptance_criteria: string;
  state: TaskState;
  context_refs: string;
  recommended_next_action: string | null;
  last_verified_checkpoint_id: string | null;
  thread_id?: string | null;
  parent_task_id?: string | null;
  title?: string | null;
  pr_number?: number | null;
  pr_url?: string | null;
  pr_state?: string | null;
  created_at: string;
  updated_at: string;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    objective: row.objective,
    acceptanceCriteria: JSON.parse(row.acceptance_criteria) as string[],
    state: row.state,
    contextRefs: JSON.parse(row.context_refs) as string[],
    ...(row.recommended_next_action !== null
      ? { recommendedNextAction: row.recommended_next_action }
      : {}),
    ...(row.last_verified_checkpoint_id !== null
      ? { lastVerifiedCheckpointId: row.last_verified_checkpoint_id }
      : {}),
    ...(row.thread_id ? { threadId: row.thread_id } : {}),
    ...(row.parent_task_id ? { parentTaskId: row.parent_task_id } : {}),
    ...(row.title ? { title: row.title } : {}),
    ...(row.pr_number ? { prNumber: row.pr_number } : {}),
    ...(row.pr_url ? { prUrl: row.pr_url } : {}),
    ...(row.pr_state === 'open' || row.pr_state === 'closed' || row.pr_state === 'merged' ? { prState: row.pr_state } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Input to {@link TaskStateMachine.transition}. */
export interface TransitionInput {
  taskId: string;
  to: TaskState;
  /** Optional step this transition is associated with. */
  stepId?: string;
  /** Minimal durable snapshot sufficient to resume; stored on the checkpoint. */
  snapshot?: unknown;
  /** Whether the committed checkpoint records a verified outcome. */
  verified?: boolean;
  /** Extra fields merged into the transition event payload for provenance. */
  eventPayload?: Record<string, unknown>;
}

/** Result of a successful transition. */
export interface TransitionResult {
  task: Task;
  event: TaskEvent;
  checkpoint: Checkpoint;
}

export class TaskStateMachine {
  constructor(
    private readonly store: Store,
    private readonly audit: AuditLog,
  ) {}

  /** Load a task by id, or `undefined` when it does not exist. */
  getTask(taskId: string): Task | undefined {
    const row = this.store.db
      .prepare(
        `SELECT id, workspace_id, objective, acceptance_criteria, state,
                context_refs, recommended_next_action,
                last_verified_checkpoint_id, thread_id, parent_task_id, title, pr_number, pr_url, pr_state, created_at, updated_at
         FROM tasks WHERE id = ?`,
      )
      .get(taskId) as TaskRow | undefined;
    return row === undefined ? undefined : rowToTask(row);
  }

  /**
   * The write-ahead transition primitive (Requirement 4.2–4.6; Property 1, 5).
   *
   * Order of operations is load-bearing:
   *  1. Reject if the task is missing.
   *  2. Reject an illegal transition — leave the state untouched, append an
   *     Audit_Event, throw {@link IllegalTransitionError}. No DB write to the
   *     task occurs. (Requirement 4.4, 4.5.)
   *  3. Otherwise commit the transition event + new state + checkpoint as ONE
   *     atomic transaction. Only after that transaction commits is the caller
   *     allowed to run any side effect of the new state. (Requirement 4.2;
   *     Property 1.)
   *  4. If that commit throws, the transaction is rolled back so the task stays
   *     in its pre-transition state; append an Audit_Event and throw
   *     {@link TransitionCommitError}. No side effect must run. (Requirement 4.3.)
   *
   * Side effects of the new state are deliberately NOT performed here — this
   * primitive only makes the transition durable. The orchestration loop reads
   * the returned state and runs the side effect afterward.
   */
  transition(input: TransitionInput): TransitionResult {
    const task = this.getTask(input.taskId);
    if (task === undefined) {
      throw new Error(`Task ${input.taskId} not found`);
    }

    const from = task.state;
    const to = input.to;

    if (!isLegalTransition(from, to)) {
      // Leave the task in its current state; record the rejected attempt.
      this.audit.append({
        actor: 'orchestrator',
        action: 'task.transition.rejected',
        target: task.id,
        redactedPayload: {
          from,
          to,
          reason: isTerminal(from)
            ? 'source state is terminal'
            : 'transition absent from Transition_Table',
        },
      });
      throw new IllegalTransitionError(from, to);
    }

    const now = new Date().toISOString();
    const verified = input.verified ?? false;
    const snapshot = input.snapshot ?? null;

    const event: TaskEvent = {
      id: randomUUID(),
      taskId: task.id,
      ...(input.stepId !== undefined ? { stepId: input.stepId } : {}),
      kind: 'transition',
      payload: { from, to, ...(input.eventPayload ?? {}) },
      createdAt: now,
    };
    const checkpoint: Checkpoint = {
      id: randomUUID(),
      taskId: task.id,
      ...(input.stepId !== undefined ? { stepId: input.stepId } : {}),
      state: to,
      snapshot,
      verified,
      createdAt: now,
    };

    try {
      // WRITE-AHEAD: event + state + checkpoint committed atomically. If any
      // statement throws, better-sqlite3 rolls the whole transaction back and
      // the task's persisted state is unchanged.
      this.store.transaction((tx) => {
        tx.db
          .prepare(
            `INSERT INTO task_events (id, task_id, step_id, kind, payload, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            event.id,
            event.taskId,
            input.stepId ?? null,
            event.kind,
            JSON.stringify(event.payload ?? null),
            event.createdAt,
          );

        tx.db
          .prepare(
            `INSERT INTO checkpoints (id, task_id, step_id, state, snapshot, verified, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            checkpoint.id,
            checkpoint.taskId,
            input.stepId ?? null,
            checkpoint.state,
            JSON.stringify(snapshot),
            verified ? 1 : 0,
            checkpoint.createdAt,
          );

        // Update the canonical state, and point the task at the verified
        // checkpoint when this transition records a verified outcome.
        tx.db
          .prepare(
            `UPDATE tasks
               SET state = ?,
                   updated_at = ?,
                   last_verified_checkpoint_id =
                     CASE WHEN ? = 1 THEN ? ELSE last_verified_checkpoint_id END
             WHERE id = ?`,
          )
          .run(to, now, verified ? 1 : 0, checkpoint.id, task.id);
      });
    } catch (err) {
      // The transaction rolled back: the task is still in `from`. No side
      // effect of `to` has run (none runs here). Record and surface.
      this.audit.append({
        actor: 'orchestrator',
        action: 'task.transition.commit_failed',
        target: task.id,
        redactedPayload: {
          from,
          to,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      throw new TransitionCommitError(from, to, err);
    }

    const updated: Task = {
      ...task,
      state: to,
      updatedAt: now,
      ...(verified ? { lastVerifiedCheckpointId: checkpoint.id } : {}),
    };
    return { task: updated, event, checkpoint };
  }
}
