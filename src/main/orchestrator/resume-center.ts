import type { Store } from '../db/types';
import type { AuditLog } from '../domain/audit-log';
import type { Registry } from '../registry/registry';
import type { ManagedStorage } from '../storage/managed-storage';
import type { TaskStateMachine } from './state-machine';
import type {
  AgentSession,
  AgentSessionStatus,
  Checkpoint,
  ResumeClassification,
  ResumeItem,
  ResumeSnapshot,
  Task,
  TaskState,
} from '@shared/domain';

// Task continuity / Resume Center — boot reconciliation (Requirement 8.1–8.4,
// 8.9; Property 2).
//
// This is the `onBoot()` algorithm from the design's "Boot reconciliation
// (crash recovery / Resume Center)" pseudocode, made durable, deterministic,
// and injectable. On every launch it:
//
//   1. loads every task in a non-terminal state (Requirement 8.1),
//   2. for each task, reconciles persisted state against REALITY — never
//      trusting prior in-memory state:
//        * probes adapter/CLI/remote session liveness through the Registry and
//          updates each session's persisted status (live / exited / orphaned),
//        * detects filesystem drift of the task's artifacts since the last
//          persisted checkpoint by checking the referenced blobs still exist in
//          Managed_Local_Storage,
//   3. classifies the task as exactly one of RESUMABLE,
//      RECOVERABLE_INTERRUPTION, or BLOCKED — deterministically: the same
//      persisted state + session liveness + subprocess state + filesystem
//      inputs always yield the same classification (Requirement 8.2, 8.3;
//      Property 2),
//   4. applies that classification through the write-ahead TaskStateMachine
//      (RECOVERABLE_INTERRUPTION / BLOCKED transitions) — RESUMABLE keeps the
//      prior non-terminal state and records no transition,
//   5. returns a ResumeSnapshot summarizing every reconciled task, which feeds
//      the Resume Center UI (task 11.2).
//
// Failure handling (Requirement 8.4): if reconciling a single task throws, or
// does not complete within a 10-second budget (measured by an injectable
// clock), that task is classified BLOCKED, its persisted state is PRESERVED (no
// state-changing transition is attempted), and an Audit_Event is appended. A
// per-task timeout never aborts reconciliation of the other tasks.
//
// Non-destructive invariant (Requirement 8.9): reconciliation NEVER destroys an
// artifact. It only probes liveness, updates session status rows, reclassifies
// task state through legal transitions, and records events. Artifact blobs are
// read-only inputs to filesystem-drift detection.
//
// An exit code of 0 is never, by itself, promoted to success here: a task is
// only RESUMABLE when a session is provably live, and verification (task 9.4)
// is the sole authority on COMPLETED. The Resume Center only ever reclassifies
// into non-terminal states.

/** The three terminal states a task can never leave. */
const TERMINAL: readonly TaskState[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

/** States that encode "the task is already waiting on a user decision". */
const DECISION_STATES: readonly TaskState[] = ['WAITING_FOR_APPROVAL', 'BLOCKED'];

/** The per-task reconciliation budget (Requirement 8.4). */
export const RECONCILE_TIMEOUT_MS = 10_000;

/**
 * Monotonic clock seam. `now()` returns elapsed milliseconds; tests inject a
 * fake that advances on demand so the 10-second timeout is exercised without
 * real wall-clock time. Defaults to the host high-resolution timer.
 */
export interface MonotonicClock {
  now(): number;
}

/** The real monotonic clock, backed by the host high-resolution timer. */
export const systemMonotonicClock: MonotonicClock = {
  now: () => Number(process.hrtime.bigint() / 1_000_000n),
};

export interface ResumeCenterOptions {
  /**
   * Managed_Local_Storage used (read-only) to detect filesystem drift of a
   * task's artifacts since the last checkpoint. Optional; when omitted, drift
   * detection reports no drift (artifacts are assumed intact) and never blocks
   * a task on missing-storage.
   */
  storage?: ManagedStorage;
  /**
   * Monotonic clock for the 10-second per-task reconciliation timeout. Defaults
   * to the host timer; tests inject a fake.
   */
  clock?: MonotonicClock;
  /** Per-task reconciliation budget in ms. Defaults to {@link RECONCILE_TIMEOUT_MS}. */
  timeoutMs?: number;
}

// ---- Row shapes read directly (the Resume Center is read-mostly) ----

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

interface SessionRow {
  id: string;
  task_id: string;
  adapter_id: string;
  external_ref: string | null;
  status: AgentSessionStatus;
  resumable: number;
  last_heartbeat_at: string | null;
  exit_code: number | null;
  created_at: string;
}

function rowToSession(row: SessionRow): AgentSession {
  return {
    id: row.id,
    taskId: row.task_id,
    adapterId: row.adapter_id,
    ...(row.external_ref !== null ? { externalRef: row.external_ref } : {}),
    status: row.status,
    resumable: row.resumable === 1,
    ...(row.last_heartbeat_at !== null
      ? { lastHeartbeatAt: row.last_heartbeat_at }
      : {}),
    ...(row.exit_code !== null ? { exitCode: row.exit_code } : {}),
    createdAt: row.created_at,
  };
}

interface CheckpointRow {
  id: string;
  task_id: string;
  step_id: string | null;
  state: TaskState;
  snapshot: string;
  verified: number;
  created_at: string;
}

function rowToCheckpoint(row: CheckpointRow): Checkpoint {
  return {
    id: row.id,
    taskId: row.task_id,
    ...(row.step_id !== null ? { stepId: row.step_id } : {}),
    state: row.state,
    snapshot: JSON.parse(row.snapshot) as unknown,
    verified: row.verified === 1,
    createdAt: row.created_at,
  };
}

/** The reconciled view of a single session after a liveness probe. */
interface ReconciledSession {
  session: AgentSession;
  status: AgentSessionStatus;
}

/**
 * The deterministic inputs the classification is a pure function of. Built once
 * per task during reconciliation and the sole argument to {@link classify}, so
 * "same inputs → same classification" is structurally guaranteed.
 */
interface ClassificationInputs {
  readonly state: TaskState;
  /** True when at least one session was probed and found provably live. */
  readonly anyLive: boolean;
  /** True when the task had any persisted session at all. */
  readonly hadSessions: boolean;
  /** True when any artifact referenced before the last checkpoint is missing. */
  readonly fsDrift: boolean;
}

/**
 * The durable, deterministic boot reconciler. Constructed once at startup and
 * invoked by {@link onBoot}. It shares the store, state machine, registry, and
 * audit log with the orchestrator so every state change still goes through the
 * write-ahead transition primitive.
 */
export class ResumeCenter {
  private readonly storage: ManagedStorage | undefined;
  private readonly clock: MonotonicClock;
  private readonly timeoutMs: number;
  /** The most recent snapshot produced by {@link onBoot}, for `resume.snapshot`. */
  private lastSnapshot: ResumeSnapshot | undefined;

  constructor(
    private readonly store: Store,
    private readonly stateMachine: TaskStateMachine,
    private readonly registry: Registry,
    private readonly audit: AuditLog,
    options: ResumeCenterOptions = {},
  ) {
    this.storage = options.storage;
    this.clock = options.clock ?? systemMonotonicClock;
    this.timeoutMs = options.timeoutMs ?? RECONCILE_TIMEOUT_MS;
  }

  /**
   * Boot reconciliation (Requirement 8.1–8.4, 8.9; Property 2).
   *
   * Loads every non-terminal task and reconciles each against reality,
   * classifying it as exactly one of RESUMABLE / RECOVERABLE_INTERRUPTION /
   * BLOCKED and returning a ResumeSnapshot. Deterministic: run twice over
   * unchanged persisted state + liveness + filesystem inputs it yields the same
   * classification for every task.
   */
  async onBoot(): Promise<ResumeSnapshot> {
    const generatedAt = new Date().toISOString();
    const live = this.loadNonTerminalTasks();
    const items: ResumeItem[] = [];

    for (const task of live) {
      items.push(await this.reconcileTask(task));
    }

    this.audit.append({
      actor: 'orchestrator',
      action: 'resume.onBoot',
      redactedPayload: {
        taskCount: items.length,
        classifications: items.map((i) => ({
          taskId: i.taskId,
          classification: i.classification,
        })),
      },
    });

    const snapshot: ResumeSnapshot = { generatedAt, items };
    this.lastSnapshot = snapshot;
    return snapshot;
  }

  /**
   * The most recent reconciliation snapshot, served to the `resume.snapshot`
   * IPC channel. The snapshot is produced by {@link onBoot} on launch;
   * re-reconciling on every renderer request would re-probe adapter liveness
   * and is unnecessary — the UI reads the boot-time classification. Returns an
   * empty snapshot (never undefined) before the first boot sweep.
   */
  snapshot(): ResumeSnapshot {
    return (
      this.lastSnapshot ?? { generatedAt: new Date().toISOString(), items: [] }
    );
  }

  /**
   * Reconcile and classify a single task. Wraps the whole per-task body in a
   * try/catch and a 10-second budget: on either a thrown reconciliation failure
   * or the budget being exceeded, the task is classified BLOCKED, its persisted
   * state is PRESERVED (no state-changing transition is attempted), and an
   * Audit_Event is appended (Requirement 8.4).
   */
  private async reconcileTask(task: Task): Promise<ResumeItem> {
    const startedAt = this.clock.now();
    try {
      // 1. Reconcile sessions against reality (probe liveness, persist status).
      const reconciled = await this.reconcileSessions(task);

      // The timeout is checked after the only async work (liveness probes): if
      // reconciling this task blew the budget, treat it as a BLOCKED timeout
      // and preserve persisted state (Requirement 8.4).
      if (this.clock.now() - startedAt > this.timeoutMs) {
        return this.blockOnFailure(task, {
          reason: 'timeout',
          elapsedMs: this.clock.now() - startedAt,
        });
      }

      // 2. Detect filesystem drift of artifacts since the last checkpoint.
      const checkpoint = this.lastCheckpoint(task.id);
      const fsDrift = this.detectFilesystemDrift(task.id, checkpoint);

      // 3. Classify deterministically from the reconciled inputs.
      const inputs: ClassificationInputs = {
        state: task.state,
        anyLive: reconciled.some((r) => r.status === 'live'),
        hadSessions: reconciled.length > 0,
        fsDrift,
      };
      const classification = classify(inputs);

      // 4. Apply the classification through the write-ahead state machine.
      this.applyClassification(task, classification);

      return this.summarize(task, checkpoint, classification);
    } catch (err) {
      // Any reconciliation failure → BLOCKED, preserve state, audit.
      return this.blockOnFailure(task, {
        reason: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Probe each of the task's persisted sessions and persist the reconciled
   * status. A probe returning true means the session is provably `live`;
   * otherwise it is `exited` when it carries an exit code and `orphaned` when it
   * does not (the design's reconciliation rule). The persisted status row is
   * updated, never deleted — reconciliation is non-destructive.
   */
  private async reconcileSessions(task: Task): Promise<ReconciledSession[]> {
    const sessions = this.sessionsFor(task.id);
    const reconciled: ReconciledSession[] = [];

    for (const session of sessions) {
      const alive = await this.registry.probeLiveness(session);
      const status: AgentSessionStatus = alive
        ? 'live'
        : session.exitCode !== undefined
          ? 'exited'
          : 'orphaned';
      this.updateSessionStatus(session.id, status);
      reconciled.push({ session, status });
    }

    return reconciled;
  }

  /**
   * Classify a task BLOCKED after a reconciliation failure or timeout WITHOUT
   * changing its persisted state (Requirement 8.4 — "preserve its persisted
   * state"). An Audit_Event records the failure cause. The returned ResumeItem
   * reports the BLOCKED classification while `state` stays the task's true,
   * untouched persisted state.
   */
  private blockOnFailure(
    task: Task,
    detail: Record<string, unknown>,
  ): ResumeItem {
    this.audit.append({
      actor: 'orchestrator',
      action: 'resume.reconcile.blocked',
      target: task.id,
      redactedPayload: { state: task.state, ...detail },
    });
    return this.summarize(task, this.lastCheckpoint(task.id), 'BLOCKED', {
      preservedState: true,
    });
  }

  /**
   * Apply a classification to the task through the write-ahead TaskStateMachine.
   *
   *   * RESUMABLE — leave the task in its prior non-terminal state; record NO
   *     transition (the orchestrator will schedule runTask for it). This is the
   *     only classification that keeps the task's state.
   *   * RECOVERABLE_INTERRUPTION — transition to RECOVERABLE_INTERRUPTION
   *     (boot-reconcile edge), unless the task is already there (idempotent: a
   *     second onBoot is a no-op).
   *   * BLOCKED — transition to BLOCKED (boot-reconcile edge), unless the task
   *     is already BLOCKED (idempotent).
   *
   * A transition that the Transition_Table rejects (e.g. the source state has
   * no boot-reconcile edge) leaves the task untouched and is recorded by the
   * state machine's own Audit_Event; the classification still reports the
   * intended value for the snapshot.
   */
  private applyClassification(
    task: Task,
    classification: ResumeClassification,
  ): void {
    if (classification === 'RESUMABLE') {
      return; // keep prior state; nothing to transition.
    }

    // A task already in a decision state (WAITING_FOR_APPROVAL or BLOCKED) is
    // classified BLOCKED but keeps its persisted state: the pending decision is
    // preserved verbatim (WAITING_FOR_APPROVAL must not be clobbered, and the
    // Transition_Table has no WAITING_FOR_APPROVAL → BLOCKED edge anyway). No
    // transition is attempted — this is also what makes a second onBoot a no-op.
    if ((DECISION_STATES as readonly TaskState[]).includes(task.state)) {
      return;
    }

    const target: TaskState =
      classification === 'RECOVERABLE_INTERRUPTION'
        ? 'RECOVERABLE_INTERRUPTION'
        : 'BLOCKED';

    if (task.state === target) {
      return; // already there — idempotent, no redundant transition.
    }

    try {
      this.stateMachine.transition({
        taskId: task.id,
        to: target,
        eventPayload: { reason: 'boot-reconcile', classification },
      });
    } catch {
      // The state machine already appended an Audit_Event for the rejected or
      // failed transition and left the task untouched. The snapshot still
      // carries the intended classification; we do not re-throw so one task's
      // non-reconcilable state never aborts the boot sweep.
      this.audit.append({
        actor: 'orchestrator',
        action: 'resume.reconcile.transition_skipped',
        target: task.id,
        redactedPayload: { from: task.state, to: target, classification },
      });
    }
  }

  /**
   * Detect filesystem drift of a task's artifacts since the last checkpoint:
   * any artifact blob referenced by a kind='artifact' task_event recorded at or
   * before the last checkpoint that is no longer present in
   * Managed_Local_Storage counts as drift. This is a read-only check — it never
   * creates, moves, or deletes a blob (Requirement 8.9). With no storage wired,
   * or no checkpoint yet, it reports no drift.
   */
  private detectFilesystemDrift(
    taskId: string,
    checkpoint: Checkpoint | undefined,
  ): boolean {
    if (this.storage === undefined || checkpoint === undefined) {
      return false;
    }
    const artifactIds = this.artifactIdsUpTo(taskId, checkpoint.createdAt);
    for (const id of artifactIds) {
      if (!this.storage.has(id)) {
        return true;
      }
    }
    return false;
  }

  /**
   * The ids of every artifact blob a task referenced at or before `isoTime`.
   * Reads kind='artifact' task_events whose payload carries an `artifactId`.
   * Deterministic (ordered, de-duplicated) so drift detection is stable.
   */
  private artifactIdsUpTo(taskId: string, isoTime: string): string[] {
    const rows = this.store.db
      .prepare(
        `SELECT payload FROM task_events
          WHERE task_id = ? AND kind = 'artifact' AND created_at <= ?
          ORDER BY created_at ASC, rowid ASC`,
      )
      .all(taskId, isoTime) as { payload: string }[];
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      let payload: unknown;
      try {
        payload = JSON.parse(row.payload);
      } catch {
        continue;
      }
      if (
        typeof payload === 'object' &&
        payload !== null &&
        'artifactId' in payload
      ) {
        const id = (payload as { artifactId: unknown }).artifactId;
        if (typeof id === 'string' && !seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
    }
    return ids;
  }

  /** Summarize a reconciled task into a ResumeItem for the snapshot. */
  private summarize(
    task: Task,
    checkpoint: Checkpoint | undefined,
    classification: ResumeClassification,
    opts: { preservedState?: boolean } = {},
  ): ResumeItem {
    // The state reported is the task's CURRENT persisted state after any
    // transition was applied (re-read so a RECOVERABLE_INTERRUPTION / BLOCKED
    // transition is reflected), or the original state when preserved on failure.
    const current =
      opts.preservedState === true
        ? task.state
        : (this.stateMachine.getTask(task.id)?.state ?? task.state);

    const lastVerifiedCheckpointId =
      task.lastVerifiedCheckpointId ??
      (checkpoint?.verified === true ? checkpoint.id : undefined);

    return {
      taskId: task.id,
      objective: task.objective,
      state: current,
      classification,
      ...(task.recommendedNextAction !== undefined
        ? { recommendedNextAction: task.recommendedNextAction }
        : {}),
      ...(lastVerifiedCheckpointId !== undefined
        ? { lastVerifiedCheckpointId }
        : {}),
      // A BLOCKED task is pending a user decision; resuming it (and any task
      // mid-side-effect) requires explicit confirmation in the Resume Center
      // UI (task 11.2 wires the consequential-action check — Requirement 8.7).
      requiresConfirmation: classification === 'BLOCKED',
    };
  }

  // ---- Read helpers ----

  /** Every task in a non-terminal state, oldest first (stable order). */
  private loadNonTerminalTasks(): Task[] {
    const placeholders = TERMINAL.map(() => '?').join(', ');
    const rows = this.store.db
      .prepare(
        `SELECT id, workspace_id, objective, acceptance_criteria, state,
                context_refs, recommended_next_action,
                last_verified_checkpoint_id, thread_id, parent_task_id, title, pr_number, pr_url, pr_state, created_at, updated_at
           FROM tasks
          WHERE state NOT IN (${placeholders})
          ORDER BY created_at ASC, rowid ASC`,
      )
      .all(...TERMINAL) as TaskRow[];
    return rows.map(rowToTask);
  }

  /** The task's persisted sessions, oldest first. */
  private sessionsFor(taskId: string): AgentSession[] {
    const rows = this.store.db
      .prepare(
        `SELECT id, task_id, adapter_id, external_ref, status, resumable,
                last_heartbeat_at, exit_code, created_at
           FROM agent_sessions
          WHERE task_id = ?
          ORDER BY created_at ASC, rowid ASC`,
      )
      .all(taskId) as SessionRow[];
    return rows.map(rowToSession);
  }

  /** The most recent checkpoint for a task, or undefined when none exists. */
  private lastCheckpoint(taskId: string): Checkpoint | undefined {
    const row = this.store.db
      .prepare(
        `SELECT id, task_id, step_id, state, snapshot, verified, created_at
           FROM checkpoints
          WHERE task_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1`,
      )
      .get(taskId) as CheckpointRow | undefined;
    return row === undefined ? undefined : rowToCheckpoint(row);
  }

  /** Persist a reconciled session status (non-destructive — update only). */
  private updateSessionStatus(
    sessionId: string,
    status: AgentSessionStatus,
  ): void {
    this.store.db
      .prepare(`UPDATE agent_sessions SET status = ? WHERE id = ?`)
      .run(status, sessionId);
  }
}

/**
 * The deterministic classification function (Requirement 8.2, 8.3; Property 2).
 *
 * A pure function of its inputs: the same {@link ClassificationInputs} always
 * map to the same classification, so two onBoot runs over unchanged persisted
 * state + liveness + filesystem inputs classify a task identically. The rules,
 * checked in priority order:
 *
 *   1. A task already waiting on a user decision (WAITING_FOR_APPROVAL /
 *      BLOCKED) is BLOCKED — a pending decision outranks liveness, since the
 *      task cannot progress without the user regardless of session state.
 *   2. Otherwise, a provably live session makes the task RESUMABLE — its work
 *      is still running and can simply continue from where it is.
 *   3. Otherwise, filesystem drift of artifacts since the last checkpoint makes
 *      the task BLOCKED — the on-disk reality no longer matches the checkpoint,
 *      so a user decision is required before any resume.
 *   4. Otherwise the task is RECOVERABLE_INTERRUPTION — it was mid-flight (no
 *      live session, no drift, or never had a session) and can be recovered
 *      from its last checkpoint.
 *
 * Note an exit code of 0 is never consulted here: liveness, not exit code,
 * decides RESUMABLE, so a process that exited is never promoted to success.
 */
export function classify(inputs: ClassificationInputs): ResumeClassification {
  if ((DECISION_STATES as readonly TaskState[]).includes(inputs.state)) {
    return 'BLOCKED';
  }
  if (inputs.anyLive) {
    return 'RESUMABLE';
  }
  if (inputs.fsDrift) {
    return 'BLOCKED';
  }
  return 'RECOVERABLE_INTERRUPTION';
}

export type { ClassificationInputs };
