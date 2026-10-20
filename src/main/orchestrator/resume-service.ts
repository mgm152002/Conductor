import type { Store } from '../db/types';
import type { AuditLog } from '../domain/audit-log';
import type { TaskStateMachine } from './state-machine';
import { isTerminal } from './state-machine';
import type { Orchestrator } from './orchestrator';
import type { TaskCanceller } from './cancellation';
import type { TaskEventEmitter } from './event-emitter';
import { noopTaskEventEmitter } from './event-emitter';
import type { StepPermissions } from './step-executor';
import type {
  PermissionRequirementKind,
  PermissionRequirement,
  ResumeAction,
  ResumeActResult,
  Task,
  TaskStep,
} from '@shared/domain';

// The Resume Center action handler (Requirement 8.5–8.8; Property 4).
//
// `ResumeCenter.onBoot` (task 11.1) reconciles every non-terminal task and
// produces the snapshot the UI renders. This module is the OTHER half of the
// Resume Center: it carries out the four per-task actions the user picks in
// that UI — Resume, Inspect, Restart, Discard — behind the `resume.act` IPC
// channel.
//
// Every state change goes through the orchestrator's durable primitives (the
// write-ahead TaskStateMachine, the StepExecutor, and the TaskCanceller), so
// durability, legal transitions, and idempotent resume are never
// re-implemented here:
//
//   * resume   — continue execution from the last checkpoint WITHOUT
//     re-executing any step already marked `succeeded` (Requirement 8.5 /
//     Property 4). The StepExecutor already skips succeeded steps and accepts a
//     task already in RUNNING, so resume is: move the task back onto the RUNNING
//     path (via the legal `resume` edge when it is in RECOVERABLE_INTERRUPTION
//     or `unblocked` when BLOCKED) and drive the executor, which picks up at the
//     first not-succeeded step. A resume that WOULD re-execute a consequential,
//     destructive, external-communication, or financial step is refused unless
//     the request carries explicit confirmation (Requirement 8.7).
//
//   * inspect  — read-only. It changes no state and performs no side effect; it
//     exists so the UI can record that the user opened the task's detail view.
//     The detail itself is read from the snapshot / task read models.
//
//   * restart  — re-run the task from the beginning: reset every step to
//     `pending` (so none are skipped) and move the task back onto the RUNNING
//     path, then drive the executor. Artifacts are preserved — restart only
//     reclassifies step status and task state (Requirement 8.9 spirit).
//
//   * discard  — abandon the task. It is refused unless the request carries
//     explicit confirmation (Requirement 8.8); on confirmation it delegates to
//     the TaskCanceller, which transitions the task to CANCELLED through the
//     write-ahead primitive and tears down any in-flight session. Artifacts are
//     NOT destroyed.
//
// The confirmation gate (Requirement 8.7, 8.8) is enforced HERE, in the main
// process, not in the renderer: an unconfirmed consequential resume or an
// unconfirmed discard returns `confirmation_required` and performs no action,
// so the gate cannot be bypassed by a crafted IPC payload.

/**
 * Requirement kinds whose re-execution needs explicit confirmation before a
 * resume (Requirement 8.7): a consequential, destructive, external, or
 * financial effect. Mirrors the Permission_Service's consequential set.
 */
const CONSEQUENTIAL_KINDS: ReadonlySet<PermissionRequirementKind> = new Set([
  'filesystem_write',
  'command_exec',
  'external_comm',
  'financial',
  'destructive',
]);


interface StepRow {
  id: string;
  task_id: string;
  ordinal: number;
  description: string;
  depends_on: string;
  assigned_adapter_id: string | null;
  input_schema_ref: string | null;
  status: TaskStep['status'];
  started_at: string | null;
  ended_at: string | null;
}

function rowToStep(row: StepRow): TaskStep {
  return {
    id: row.id,
    taskId: row.task_id,
    ordinal: row.ordinal,
    description: row.description,
    dependsOn: JSON.parse(row.depends_on) as string[],
    ...(row.assigned_adapter_id !== null
      ? { assignedAdapterId: row.assigned_adapter_id }
      : {}),
    ...(row.input_schema_ref !== null
      ? { inputSchemaRef: row.input_schema_ref }
      : {}),
    status: row.status,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.ended_at !== null ? { endedAt: row.ended_at } : {}),
  };
}

export interface ResumeServiceOptions {
  /**
   * Resolver for a persisted step's declared permission requirements, used to
   * decide whether a resume would re-execute a consequential action
   * (Requirement 8.7). Defaults to "no requirements" — matching the M1–M3
   * placeholder planner's permission-free step — so a plain resume never needs
   * confirmation until a richer plan store declares real requirements. Inject
   * the SAME resolver the orchestrator's StepExecutor uses so the
   * confirmation gate and the execution gate agree.
   */
  stepPermissions?: StepPermissions;
  /** Renderer event-emit seam; defaults to a no-op (headless). */
  emitter?: TaskEventEmitter;
}

/**
 * Carries out Resume Center actions for a single task. Constructed once at
 * startup beside the orchestrator and invoked by the `resume.act` IPC handler.
 */
export class ResumeService {
  private readonly stepPermissions: StepPermissions;
  private readonly emitter: TaskEventEmitter;

  constructor(
    private readonly store: Store,
    private readonly stateMachine: TaskStateMachine,
    private readonly orchestrator: Orchestrator,
    private readonly canceller: TaskCanceller,
    private readonly audit: AuditLog,
    options: ResumeServiceOptions = {},
  ) {
    this.stepPermissions = options.stepPermissions ?? ((step) => {
      const row = store.db.prepare('SELECT required_permissions FROM task_steps WHERE id=?').get(step.id) as {required_permissions:string}|undefined;
      return row ? JSON.parse(row.required_permissions) as PermissionRequirement[] : [];
    });
    this.emitter = options.emitter ?? noopTaskEventEmitter;
  }

  /**
   * Carry out a Resume Center action (Requirement 8.5–8.8). Returns a
   * {@link ResumeActResult} describing what happened — in particular
   * `confirmation_required` when a consequential resume or a discard was
   * refused for lack of explicit confirmation, so the UI can re-issue the
   * action with `confirmed: true`.
   */
  async act(input: {
    taskId: string;
    action: ResumeAction;
    confirmed?: boolean;
  }): Promise<ResumeActResult> {
    const task = this.stateMachine.getTask(input.taskId);
    if (task === undefined) {
      throw new Error(`Task ${input.taskId} not found`);
    }

    switch (input.action) {
      case 'inspect':
        return this.inspect(task);
      case 'resume':
        return this.resume(task, input.confirmed === true);
      case 'restart':
        return this.restart(task, input.confirmed === true);
      case 'discard':
        return this.discard(task, input.confirmed === true);
    }
  }

  // ---- inspect (read-only) ----

  /**
   * Inspect is read-only: it never changes state or performs a side effect. It
   * records that the user opened the task's detail view and reports the task's
   * current state unchanged.
   */
  private inspect(task: Task): ResumeActResult {
    this.audit.append({
      actor: 'user',
      action: 'resume.inspect',
      target: task.id,
      redactedPayload: { state: task.state },
    });
    return { taskId: task.id, action: 'inspect', status: 'noop', state: task.state };
  }

  // ---- resume (idempotent — never re-runs a succeeded step) ----

  /**
   * Resume a reconciled task from its last checkpoint. The StepExecutor skips
   * every step already `succeeded` (Property 4), so resuming is: move the task
   * onto the RUNNING path through a legal transition when needed, then drive
   * the executor from the first not-succeeded step.
   *
   * Before doing any of that, if the first not-succeeded step would re-execute
   * a consequential / destructive / external / financial action and the request
   * was not confirmed, refuse with `confirmation_required` and change nothing
   * (Requirement 8.7).
   */
  private async resume(task: Task, confirmed: boolean): Promise<ResumeActResult> {
    if (isTerminal(task.state)) {
      throw new Error(`Task ${task.id} is terminal and cannot be resumed`);
    }

    // Confirmation gate (Requirement 8.7): a resume that would re-execute a
    // consequential action requires explicit confirmation.
    if (!confirmed && this.resumeIsConsequential(task.id)) {
      this.audit.append({
        actor: 'orchestrator',
        action: 'resume.confirmation_required',
        target: task.id,
        redactedPayload: { reason: 'consequential' },
      });
      return {
        taskId: task.id,
        action: 'resume',
        status: 'confirmation_required',
        state: task.state,
        confirmationReason: 'consequential',
      };
    }

    // Move the task onto the RUNNING path if it is not already there, using the
    // legal edge for its current state. The executor itself performs the
    // PLANNING → RUNNING transition when the task is in PLANNING, so only the
    // interruption/decision states need an explicit resume edge here.
    this.moveOntoRunningPath(task);

    this.audit.append({
      actor: 'user',
      action: 'resume.resume',
      target: task.id,
      redactedPayload: { from: task.state, confirmed },
    });

    const result = await this.orchestrator.runSteps(task.id);
    this.emitTaskUpdated(task.id);
    return {
      taskId: task.id,
      action: 'resume',
      status: 'applied',
      state: result.state,
    };
  }

  // ---- restart (re-run from the beginning) ----

  /**
   * Restart re-runs the task from the beginning: every step is reset to
   * `pending` so none is skipped, then the task is moved onto the RUNNING path
   * and the executor is driven. Artifacts are preserved — only step status and
   * task state are changed.
   */
  private async restart(task: Task, confirmed: boolean): Promise<ResumeActResult> {
    if (isTerminal(task.state)) {
      throw new Error(`Task ${task.id} is terminal and cannot be restarted`);
    }

    const consequential = this.loadSteps(task.id).some((step) =>
      this.stepPermissions(step).some((req) => CONSEQUENTIAL_KINDS.has(req.kind)));
    if (consequential && !confirmed) return {taskId:task.id,action:'restart',status:'confirmation_required',state:task.state,confirmationReason:'consequential'};
    // Restart is a fresh authorization boundary: old step approvals must not authorize re-execution.
    this.store.db.prepare("UPDATE approval_requests SET status='expired' WHERE task_id=? AND status='approved'").run(task.id);

    // Reset every step to pending so the executor re-runs the whole DAG.
    this.store.db
      .prepare(
        `UPDATE task_steps
            SET status = 'pending', started_at = NULL, ended_at = NULL
          WHERE task_id = ?`,
      )
      .run(task.id);

    this.moveOntoRunningPath(task);

    this.audit.append({
      actor: 'user',
      action: 'resume.restart',
      target: task.id,
      redactedPayload: { from: task.state },
    });

    const result = await this.orchestrator.runSteps(task.id);
    this.emitTaskUpdated(task.id);
    return {
      taskId: task.id,
      action: 'restart',
      status: 'applied',
      state: result.state,
    };
  }

  // ---- discard (requires confirmation) ----

  /**
   * Discard abandons the task. It is refused unless the request carries
   * explicit confirmation (Requirement 8.8). On confirmation it delegates to
   * the TaskCanceller, which transitions the task to CANCELLED through the
   * write-ahead primitive and tears down any in-flight session. Artifacts are
   * NOT destroyed.
   */
  private async discard(task: Task, confirmed: boolean): Promise<ResumeActResult> {
    if (!confirmed) {
      this.audit.append({
        actor: 'orchestrator',
        action: 'resume.confirmation_required',
        target: task.id,
        redactedPayload: { reason: 'discard' },
      });
      return {
        taskId: task.id,
        action: 'discard',
        status: 'confirmation_required',
        state: task.state,
        confirmationReason: 'discard',
      };
    }

    if (isTerminal(task.state)) {
      // Already terminal — discarding is a no-op (the task cannot leave a
      // terminal state); report its state unchanged.
      return {
        taskId: task.id,
        action: 'discard',
        status: 'noop',
        state: task.state,
      };
    }

    this.audit.append({
      actor: 'user',
      action: 'resume.discard',
      target: task.id,
      redactedPayload: { from: task.state },
    });

    const result = await this.canceller.cancelTask(task.id);
    this.emitTaskUpdated(task.id);
    return {
      taskId: task.id,
      action: 'discard',
      status: 'applied',
      state: result.state,
    };
  }

  // ---- helpers ----

  /**
   * Whether resuming the task would re-execute a consequential / destructive /
   * external / financial step: true when ANY not-yet-succeeded step declares a
   * permission requirement of a consequential kind. Succeeded steps are skipped
   * on resume (Property 4) so they are irrelevant to the gate.
   */
  private resumeIsConsequential(taskId: string): boolean {
    const pending = this.loadSteps(taskId).filter(
      (step) => step.status !== 'succeeded',
    );
    for (const step of pending) {
      for (const req of this.stepPermissions(step)) {
        if (CONSEQUENTIAL_KINDS.has(req.kind)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Move a task onto the RUNNING execution path using the legal transition for
   * its current state, so the StepExecutor can pick up from the first
   * not-succeeded step:
   *   * RECOVERABLE_INTERRUPTION → RUNNING  (the `resume` edge)
   *   * BLOCKED                  → RUNNING  (the `unblocked` edge)
   * A task already in RUNNING, or in PLANNING / CONTEXT_LOADING (the executor
   * drives PLANNING → RUNNING itself), is left as-is. A state with no legal
   * edge to RUNNING is also left as-is; the executor then runs against the
   * current state (and a terminal task was already rejected by the caller).
   */
  private moveOntoRunningPath(task: Task): void {
    const current = this.stateMachine.getTask(task.id)?.state ?? task.state;
    if (current === 'RECOVERABLE_INTERRUPTION' || current === 'BLOCKED') {
      this.stateMachine.transition({
        taskId: task.id,
        to: 'RUNNING',
        eventPayload: { reason: 'resume' },
      });
    }
  }

  private loadSteps(taskId: string): TaskStep[] {
    const rows = this.store.db
      .prepare(
        `SELECT id, task_id, ordinal, description, depends_on,
                assigned_adapter_id, input_schema_ref, status, started_at, ended_at
           FROM task_steps WHERE task_id = ? ORDER BY ordinal ASC, rowid ASC`,
      )
      .all(taskId) as StepRow[];
    return rows.map(rowToStep);
  }

  private emitTaskUpdated(taskId: string): void {
    const task = this.stateMachine.getTask(taskId);
    if (task === undefined) {
      return;
    }
    this.emitter.emit('task.updated', task);
  }
}

export type { ResumeActResult } from '@shared/domain';
