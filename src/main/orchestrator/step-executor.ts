import { redact } from '../ipc/redaction';
import { randomUUID } from 'node:crypto';
import { compareAgentPreference } from '@shared/agent-preference';
import type { Store } from '../db/types';
import type { AuditLog } from '../domain/audit-log';
import type { Registry } from '../registry/registry';
import type {
  PermissionService,
  PermissionSubject,
} from '../domain/permission-service';
import type { ManagedStorage } from '../storage/managed-storage';
import { usageFromEvent, type UsageRecorder } from '../usage/usage';
import { quotaFromEvent, type QuotaRecorder } from '../usage/quota';
import { classifyFailure, retryableOnAnotherAgent, tailLines, type FailureKind } from '../adapters/failure-classification';
import { stepReply } from './thread-context';
import type { TaskStateMachine } from './state-machine';
import { isTerminal } from './state-machine';
import type { TaskEventEmitter } from './event-emitter';
import { noopTaskEventEmitter } from './event-emitter';
import type {
  AdapterResult,
  AdapterSessionHandle,
  AdapterStreamEvent,
  AgentAdapter,
} from '@shared/adapter';
import type {
  PermissionRequirement,
  Task,
  TaskStep,
  TaskState,
} from '@shared/domain';

// The RUNNING step-execution path (Requirement 5.5, 5.7; 9.2).
//
// This is the executeSteps(task) algorithm from the design's "Step execution
// with streaming, cancellation, and checkpointing" pseudocode, made durable and
// injectable. It sits on top of the write-ahead TaskStateMachine (the only
// authority on legal transitions) and runs ONLY after a task has reached
// PLANNING with a routed DAG persisted in task_steps (task 9.2).
//
// What it does, per step in topological order:
//   * skips any step already status='succeeded' so a resume never re-executes
//     completed work (idempotent resume — Requirement 5.5 / Property 4 entry),
//   * gates a step whose declared permissions require approval through
//     WAITING_FOR_APPROVAL before any adapter runs (Requirement 9.2): it
//     requests the approval via the PermissionService and suspends — RUNNING
//     execution does not resume the step until the approval is resolved,
//   * resolves the step's assigned adapter from the Registry and starts a
//     session, persisting the agent_session row,
//   * consumes the adapter's stream, persisting a checkpoint AND a kind='stream'
//     task_event per consumed event, persisting any artifact event through
//     Managed_Local_Storage, and emitting a task.stream renderer event per
//     event (Requirement 5.5 — within one second of each step state change),
//   * on terminal adapter outcome: an exit code is NEVER by itself success; a
//     failed-but-retryable step is retried with bounded backoff; an exhausted
//     or non-retryable failure persists the step as failed and transitions the
//     task to VERIFYING so verification (task 9.4) decides FAILED vs recoverable,
//   * persists collected artifacts before any terminal transition and, once
//     every step has succeeded, transitions RUNNING → VERIFYING.
//
// VERIFYING logic itself is task 9.4 — this module stops at the VERIFYING
// transition.
//
// Every seam that would otherwise bind this to wall-clock time or Electron is
// injectable: the backoff sleep is a {@link BackoffClock} and the renderer
// emit is a {@link TaskEventEmitter}, so the whole path is exercised in tests
// with a FakeAdapter and zero real delay.

/** A step row as persisted in task_steps, before adapter assignment resolves. */
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

/**
 * Injectable backoff seam. `sleep(ms)` resolves after the bounded backoff delay
 * for a retry; tests swap a fake that resolves immediately (and can record the
 * delays requested) so retry/backoff is exercised without real wall-clock time.
 */
export interface BackoffClock {
  sleep(ms: number): Promise<void>;
}

/** The real backoff clock, backed by the host timer. */
export const systemBackoffClock: BackoffClock = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * How a step maps its declared permissions. The orchestrator persists only the
 * adapter assignment on a step row (task 9.2), not the permission list, so the
 * executor resolves a step's permission requirements through this seam. The
 * default resolves to no requirements (the placeholder planner's step needs no
 * special permission); a richer plan store supplies the real list.
 */
export type StepPermissions = (
  step: TaskStep,
) => readonly PermissionRequirement[];

export interface StepExecutorOptions {
  /** Resolve transient content immediately before starting an adapter. */
  resolveInput?: (step: TaskStep, base: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** Managed_Local_Storage for persisting artifact stream events. Optional. */
  storage?: ManagedStorage;
  /** Renderer event-emit seam. Defaults to a no-op (headless). */
  emitter?: TaskEventEmitter;
  /** Backoff seam for bounded retries. Defaults to the host timer. */
  backoffClock?: BackoffClock;
  /** Resolver for a step's declared permission requirements. */
  stepPermissions?: StepPermissions;
  /** The subject whose grants gate approval of a step. */
  subject?: PermissionSubject;
  /** Max retries per step before it is persisted failed. Defaults to 2. */
  maxRetries?: number;
  /** Base backoff in ms; the nth retry waits base * 2^(n-1). Defaults to 100. */
  baseBackoffMs?: number;
  /** Most steps of one task that run at the same time. Defaults to 4. */
  maxParallel?: number;
  /** Records token usage reported in adapter streams. */
  usage?: UsageRecorder;
  /** Records quota windows reported in adapter streams. */
  quota?: QuotaRecorder;
  /** Called after each step settles (succeeded, failed or cancelled). */
  onStepSettled?: (taskId: string, stepId: string) => void;
  /** Settings-configured fallback model for an agent after a retryable failure. */
  fallbackModel?: (agentId: string) => string | undefined;
}

/** Default number of steps of one task that run at once. */
export const DEFAULT_MAX_PARALLEL = 4;

/** Default maximum retries per step (bounded — Requirement 5.7). */
export const DEFAULT_MAX_RETRIES = 2;
/** Default base backoff before the first retry (ms). */
export const DEFAULT_BASE_BACKOFF_MS = 100;

/** Terminal outcome kind of an executeSteps run, for the caller/tests. */
export type ExecuteStepsOutcome =
  | 'verifying' // every step succeeded (or was already succeeded); → VERIFYING
  | 'waiting_for_approval' // a step gated on approval; suspended in WAITING_FOR_APPROVAL
  | 'failed_to_verifying' // a step failed; task moved to VERIFYING to adjudicate
  | 'cancelled' // the task was cancelled before/while stepping
  | 'already_terminal'; // the task was terminal when execution was asked to run

export interface ExecuteStepsResult {
  outcome: ExecuteStepsOutcome;
  state: TaskState;
}

/** The subject whose grants gate step approval when none is injected. */
const DEFAULT_SUBJECT: PermissionSubject = { type: 'agent', id: 'orchestrator' };

/**
 * Drives RUNNING step execution for a single task. Constructed once per
 * orchestrator and invoked on a task whose DAG is already persisted and routed.
 */
export class StepExecutor {
  private readonly storage: ManagedStorage | undefined;
  private readonly emitter: TaskEventEmitter;
  private readonly backoffClock: BackoffClock;
  private readonly stepPermissions: StepPermissions;
  private readonly subject: PermissionSubject;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;
  private readonly maxParallel: number;
  private readonly usage: UsageRecorder | undefined;
  private readonly quota: QuotaRecorder | undefined;
  private readonly resolveInput: StepExecutorOptions['resolveInput'];
  private readonly onStepSettled: ((taskId: string, stepId: string) => void) | undefined;
  private readonly fallbackModel: StepExecutorOptions['fallbackModel'];

  constructor(
    private readonly store: Store,
    private readonly stateMachine: TaskStateMachine,
    private readonly registry: Registry,
    private readonly permissions: PermissionService,
    private readonly audit: AuditLog,
    options: StepExecutorOptions = {},
  ) {
    this.storage = options.storage;
    this.emitter = options.emitter ?? noopTaskEventEmitter;
    this.backoffClock = options.backoffClock ?? systemBackoffClock;
    this.stepPermissions = options.stepPermissions ?? ((step) => {
      const row = store.db.prepare('SELECT required_permissions FROM task_steps WHERE id = ?')
        .get(step.id) as { required_permissions: string } | undefined;
      return row ? JSON.parse(row.required_permissions) as PermissionRequirement[] : [];
    });
    this.subject = options.subject ?? DEFAULT_SUBJECT;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.maxParallel = Math.max(1, options.maxParallel ?? DEFAULT_MAX_PARALLEL);
    this.usage = options.usage;
    this.quota = options.quota;
    this.resolveInput = options.resolveInput;
    this.onStepSettled = options.onStepSettled;
    this.fallbackModel = options.fallbackModel;
  }

  /** Tell observers that a step reached a final status. */
  private stepSettled(taskId: string, stepId: string): void {
    try { this.onStepSettled?.(taskId, stepId); } catch { /* observers never affect execution */ }
  }

  /**
   * Execute the task's steps (Requirement 5.5, 5.7; 9.2).
   *
   * The task must be in PLANNING (the normal entry, driven by the orchestrator
   * once the routed DAG is persisted). This:
   *   1. gates on approval FIRST — if the very first not-yet-succeeded step
   *      declares permissions that require approval under the active profile,
   *      the task transitions PLANNING → WAITING_FOR_APPROVAL, an
   *      Approval_Request is created, and execution suspends without RUNNING
   *      being entered or any adapter started (Requirement 9.2);
   *   2. otherwise transitions PLANNING → RUNNING (write-ahead) and runs each
   *      step in the persisted topological order, skipping already-succeeded
   *      steps (idempotent resume);
   *   3. on all steps done, transitions RUNNING → VERIFYING.
   *
   * It stops at the VERIFYING transition — verification is task 9.4.
   *
   * A task already in RUNNING (e.g. resumed after a crash) is accepted and
   * stepping continues from the first not-succeeded step; a terminal task is a
   * no-op.
   */
  async executeSteps(taskId: string): Promise<ExecuteStepsResult> {
    const task = this.stateMachine.getTask(taskId);
    if (task === undefined) {
      throw new Error(`Task ${taskId} not found`);
    }
    if (isTerminal(task.state)) {
      return { outcome: 'already_terminal', state: task.state };
    }

    const steps = this.loadSteps(taskId);
    // The next step that still needs running (first non-succeeded in order).
    if (steps.length === 0) throw new Error('Task has no execution plan; replan before running');
    if (task.state === 'WAITING_FOR_APPROVAL' && this.permissions.pendingApprovals(taskId).length > 0) {
      return { outcome: 'waiting_for_approval', state: task.state };
    }
    const pending = steps.filter((s) => s.status !== 'succeeded');

    // 1. Approval gate (Requirement 9.2). Check the first pending step BEFORE
    //    entering RUNNING: if it needs an approval the subject does not already
    //    hold outright, gate through WAITING_FOR_APPROVAL and suspend.
    const firstPending = pending[0];
    if (firstPending !== undefined) {
      const gate = this.approvalGateFor(firstPending);
      if (gate.requiresApproval) {
        return this.gateOnApproval(task, firstPending, gate.requirements);
      }
    }

    // 2. Enter RUNNING (write-ahead) unless already there. PLANNING → RUNNING is
    //    the "plan-ready (no approval)" edge; a resumed task may already be in
    //    RUNNING, in which case we continue without a redundant transition.
    if (task.state !== 'RUNNING') {
      this.stateMachine.transition({
        taskId,
        to: 'RUNNING',
        eventPayload: { reason: 'plan-ready' },
      });
      this.emitTaskUpdated(taskId);
    }

    // 3. Run the DAG. A step starts as soon as every step it depends on has
    //    succeeded, up to `maxParallel` at a time, so independent steps (for
    //    example a plan's tasks in the same wave) run on their agents in
    //    parallel. Already-succeeded steps never re-run (idempotent resume).
    //
    //    The task stays RUNNING throughout: per-tool-call approvals don't change
    //    task state. An up-front approval gate only suspends the task once no
    //    sibling is running, and a failure stops new starts but lets running
    //    siblings finish before the task moves to VERIFYING.
    const known = new Set(steps.map((s) => s.id));
    const status = new Map<string, 'pending' | 'running' | 'succeeded' | 'failed'>(
      steps.map((s) => [s.id, s.status === 'succeeded' ? 'succeeded' : 'pending']),
    );
    const running = new Map<string, Promise<void>>();
    let failedStepId: string | undefined;
    let thrown: { error: unknown } | undefined;
    let gated: TaskStep | undefined;
    const ready = (): TaskStep[] => steps.filter((s) => status.get(s.id) === 'pending'
      && s.dependsOn.every((dep) => !known.has(dep) || status.get(dep) === 'succeeded'));

    while (true) {
      const current = this.stateMachine.getTask(taskId);
      const ended = current === undefined || isTerminal(current.state);
      if (!ended && failedStepId === undefined && thrown === undefined && gated === undefined) {
        for (const step of ready()) {
          if (running.size >= this.maxParallel) break;
          let gate: ReturnType<StepExecutor['approvalGateFor']>;
          try { gate = this.approvalGateFor(step); }
          catch (error) { thrown = { error }; break; }
          if (gate.requiresApproval) {
            if (running.size === 0) return this.gateOnApproval(current, step, gate.requirements);
            gated = step; // gate once the running siblings have finished
            break;
          }
          status.set(step.id, 'running');
          const run = this.runStep(current, step).then(
            (result) => {
              status.set(step.id, result);
              if (result === 'failed') failedStepId ??= step.id;
            },
            (error: unknown) => {
              status.set(step.id, 'failed');
              thrown ??= { error };
            },
          ).finally(() => {
            running.delete(step.id);
            this.stepSettled(taskId, step.id);
          });
          running.set(step.id, run);
        }
      }
      if (running.size === 0) break;
      await Promise.race(running.values());
    }

    const afterRun = this.stateMachine.getTask(taskId);
    if (afterRun === undefined || isTerminal(afterRun.state)) {
      return { outcome: 'cancelled', state: afterRun?.state ?? 'CANCELLED' };
    }
    // An unexpected error (e.g. a revoked permission) blocks the task; steps
    // that never ran stay pending so a retry can pick them up.
    if (thrown !== undefined) throw thrown.error;
    if (gated !== undefined && failedStepId === undefined) {
      const gate = this.approvalGateFor(gated);
      if (gate.requiresApproval) return this.gateOnApproval(afterRun, gated, gate.requirements);
      return this.executeSteps(taskId);
    }
    const unfinished = steps.filter((s) => status.get(s.id) === 'pending');
    if (failedStepId !== undefined || unfinished.length > 0) {
      // A step exhausted retries or failed unrecoverably (its artifacts are
      // already persisted). Steps that can no longer run are skipped, and
      // verification decides FAILED vs RECOVERABLE_INTERRUPTION — exit code
      // alone never completes a task (Property 3).
      for (const step of unfinished) this.markStep(step.id, 'skipped');
      this.stateMachine.transition({
        taskId,
        to: 'VERIFYING',
        ...(failedStepId !== undefined ? { stepId: failedStepId } : {}),
        eventPayload: { reason: 'step-failed', ...(unfinished.length > 0 ? { skipped: unfinished.length } : {}) },
      });
      this.emitTaskUpdated(taskId);
      const after = this.stateMachine.getTask(taskId);
      return {
        outcome: 'failed_to_verifying',
        state: after?.state ?? 'VERIFYING',
      };
    }

    // 4. Every step succeeded: transition RUNNING → VERIFYING (steps-done).
    //    Verification itself is task 9.4; we stop here.
    this.stateMachine.transition({
      taskId,
      to: 'VERIFYING',
      eventPayload: { reason: 'steps-done' },
    });
    this.emitTaskUpdated(taskId);
    const after = this.stateMachine.getTask(taskId);
    return { outcome: 'verifying', state: after?.state ?? 'VERIFYING' };
  }

  // ---- Approval gating (Requirement 9.2) ----

  /**
   * Whether a step must be gated through WAITING_FOR_APPROVAL before it runs,
   * and the permission requirements that drive that gate. A step is gated when
   * any of its declared permissions is not allowed outright for the subject but
   * IS permitted behind an approval under the active profile. A requirement the
   * subject can neither perform nor be approved for is NOT handled here — it is
   * a routing concern that would have blocked planning (task 9.2) before the
   * step was ever persisted.
   */
  private asksPerToolCall(step: TaskStep): boolean {
    if (step.assignedAdapterId === undefined || !this.registry.has(step.assignedAdapterId)) return false;
    const row = this.store.db.prepare('SELECT required_capability FROM task_steps WHERE id = ?').get(step.id) as { required_capability: string | null } | undefined;
    return this.registry.resolve(step.assignedAdapterId).record.capabilities
      .some((c) => c.id === row?.required_capability && c.toolApprovals === true);
  }

  private approvalGateFor(step: TaskStep): {
    requiresApproval: boolean;
    requirements: PermissionRequirement[];
  } {
    const required = this.stepPermissions(step);
    const approvals = this.store.db.prepare(
      "SELECT requirements FROM approval_requests WHERE task_id = ? AND step_id = ? AND status = 'approved'",
    ).all(step.taskId, step.id) as { requirements: string }[];
    const approved = approvals.flatMap((a) => JSON.parse(a.requirements) as PermissionRequirement[]);
    for (const req of required) {
      if (!this.permissions.allows(this.subject, req) && !this.permissions.requiresApproval(this.subject, req)) {
        throw new Error(`Permission denied or revoked: ${req.kind}`);
      }
    }
    // Agents that ask per tool call are not gated up front; their individual
    // commands and file changes come to the user as they happen.
    if (this.asksPerToolCall(step)) return { requiresApproval: false, requirements: [] };
    const needsApproval = required.filter(
      (req) =>
        !this.permissions.allows(this.subject, req) &&
        this.permissions.requiresApproval(this.subject, req) &&
        !approved.some((a) => a.kind === req.kind && a.scope === req.scope),
    );
    return {
      requiresApproval: needsApproval.length > 0,
      requirements: [...needsApproval],
    };
  }

  /**
   * Transition the task to WAITING_FOR_APPROVAL (write-ahead) and create a
   * pending Approval_Request for the gating requirements, then suspend. RUNNING
   * is never entered for this step until the approval resolves and execution is
   * driven again.
   */
  private gateOnApproval(
    task: Task,
    step: TaskStep,
    requirements: PermissionRequirement[],
  ): ExecuteStepsResult {
    if (task.state !== 'WAITING_FOR_APPROVAL') {
      this.stateMachine.transition({
        taskId: task.id,
        to: 'WAITING_FOR_APPROVAL',
        stepId: step.id,
        eventPayload: { reason: 'needs-approval', stepId: step.id },
      });
    }

    this.permissions.requestApproval({
      taskId: task.id,
      stepId: step.id,
      subject: this.subject,
      summary: `Approval required for step: ${step.description}`,
      requirements,
    });

    this.emitTaskUpdated(task.id);
    const after = this.stateMachine.getTask(task.id);
    return {
      outcome: 'waiting_for_approval',
      state: after?.state ?? 'WAITING_FOR_APPROVAL',
    };
  }

  // ---- Single-step execution with streaming, artifacts, retries ----

  /**
   * Run one step to a terminal step status, with bounded retries and backoff.
   * Returns 'succeeded' or 'failed'. Artifacts streamed during any attempt are
   * persisted as they arrive, so they survive even a subsequent failure
   * (Requirement 5.7 — artifacts persisted before a terminal transition).
   */
  private async runStep(
    task: Task,
    step: TaskStep,
    tried: Set<string> = new Set(),
    fallbackModelTried: Set<string> = new Set(),
  ): Promise<'succeeded' | 'failed'> {
    // A step must have been routed to an adapter in planning. A step with no
    // assigned adapter is a deterministic-fallback step; running those lands in
    // a later milestone, so treat it as failed-to-verify rather than crashing.
    if (step.assignedAdapterId === undefined) {
      this.markStep(step.id, 'failed');
      this.audit.append({
        actor: 'orchestrator',
        action: 'task.step.no_adapter',
        target: task.id,
        redactedPayload: { stepId: step.id },
      });
      return 'failed';
    }

    let adapter: AgentAdapter;
    try {
      adapter = this.registry.resolve(step.assignedAdapterId);
    } catch {
      this.markStep(step.id, 'failed');
      this.audit.append({
        actor: 'orchestrator',
        action: 'task.step.adapter_unresolved',
        target: task.id,
        redactedPayload: { stepId: step.id, adapterId: step.assignedAdapterId },
      });
      return 'failed';
    }
    tried.add(step.assignedAdapterId);
    // Recent stderr, so a terminal failure can be classified as quota vs other.
    const errorSink: string[] = [];

    // Register before start(): revocation can land while the adapter is still
    // creating a session. Dispose on every return/retry so grants never retain
    // callbacks for completed attempts.
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const taskEnded = (): boolean => isTerminal(this.stateMachine.getTask(task.id)?.state ?? 'CANCELLED');
      if (taskEnded()) return 'failed';
      if (attempt > 0) await this.backoffClock.sleep(this.baseBackoffMs * 2 ** (attempt - 1));
      if (taskEnded()) return 'failed';
      if (this.approvalGateFor(step).requiresApproval) throw new Error('Permission now requires approval; retry after reviewing the step');
      this.markStep(step.id, 'running', { startedAt: true });

      let handle: AdapterSessionHandle | undefined;
      let sessionId: string | undefined;
      let aborted = false;
      let cancelPromise: Promise<void> | undefined;
      const cancelHandle = (): Promise<void> | undefined => {
        if (handle && !cancelPromise) {
          const target = handle;
          cancelPromise = Promise.resolve().then(() => adapter.cancel(target)).catch((err: unknown) => {
            this.recordStepError(task.id, step.id, 'cancel', err);
          });
        }
        return cancelPromise;
      };
      const requestAbort = (): void => { aborted = true; void cancelHandle(); };
      const stopped = (): boolean => aborted || taskEnded();
      const stopAttempt = async (): Promise<'failed'> => {
        requestAbort(); await cancelHandle();
        if (sessionId) this.markSessionExited(sessionId, 'orphaned');
        this.markStep(step.id, 'cancelled', { endedAt: true });
        return 'failed';
      };
      const disposers = this.stepPermissions(step).map((requirement) => this.permissions.registerInFlight({
        subject: this.subject, requirement, cancel: requestAbort,
      }));
      try {
        try {
          const input = await this.stepInput(step);
          if (stopped()) return stopAttempt();
          handle = await adapter.start(input);
          sessionId = this.insertAgentSession(task.id, handle, step.id);
        } catch (err) {
          this.recordStepError(task.id, step.id, 'start', err);
          await cancelHandle();
          if (stopped()) return stopAttempt();
          if (attempt < this.maxRetries) continue;
          this.markStep(step.id, 'failed'); return 'failed';
        }
        // Cancellation may have happened before the handle existed and before
        // TaskCanceller could discover its durable agent_session row.
        if (stopped()) return stopAttempt();

        try {
          await this.consumeStream(task.id, step, handle, sessionId, adapter, attempt, stopped, errorSink);
        } catch (err) {
          this.recordStepError(task.id, step.id, 'stream', err);
          await cancelHandle();
          this.markSessionExited(sessionId, 'orphaned');
          if (stopped()) return stopAttempt();
          if (attempt < this.maxRetries) continue;
          this.markStep(step.id, 'failed'); return 'failed';
        }
        if (stopped()) return stopAttempt();

        let result: AdapterResult;
        try { result = await adapter.await(handle); }
        catch (err) {
          this.recordStepError(task.id, step.id, 'await', err);
          await cancelHandle();
          this.markSessionExited(sessionId, 'orphaned');
          if (stopped()) return stopAttempt();
          if (attempt < this.maxRetries) continue;
          this.markStep(step.id, 'failed'); return 'failed';
        }
        if (stopped()) return stopAttempt();

        this.persistResultArtifacts(task.id, step.id, result, sessionId, attempt);
        this.markSessionExited(sessionId, result.status === 'succeeded' ? 'exited' : 'orphaned');
        if (result.status === 'succeeded') {
          this.markStep(step.id, 'succeeded', { endedAt: true });
          this.checkpoint(task.id, step.id, 'RUNNING', { step: step.id, status: 'succeeded', sessionId, attempt });
          return 'succeeded';
        }
        if (result.status === 'failed' && attempt < this.maxRetries) {
          this.audit.append({actor:'orchestrator',action:'task.step.retry',target:task.id,
            redactedPayload:{stepId:step.id,attempt:attempt+1,maxRetries:this.maxRetries}});
          continue;
        }
        // Quota exhaustion or a model this CLI cannot run is retryable on a
        // different provider: if another available agent can fulfil this step,
        // re-point the step to it and run it there rather than letting the
        // task fail (Property 3 still holds — only verification completes a
        // task). Any other failure, or no alternate, ends the step as failed.
        const failure = result.status === 'failed' ? classifyFailure(result, tailLines(errorSink)) : 'other';
        if (retryableOnAnotherAgent(failure)
          && this.retryWithFallbackModel(task, step, failure, fallbackModelTried)) {
          return this.runStep(task, this.stepRow(step.id) ?? step, tried, fallbackModelTried);
        }
        if (retryableOnAnotherAgent(failure)
          && await this.repointToFallback(task, step, tried, failure)) {
          return this.runStep(task, this.stepRow(step.id) ?? step, tried, fallbackModelTried);
        }
        this.markStep(step.id, result.status === 'cancelled' ? 'cancelled' : 'failed');
        return 'failed';
      } finally {
        for (const dispose of disposers) dispose();
      }
    }
    this.markStep(step.id, 'failed'); return 'failed';
  }

  /**
   * Consume an adapter's stream, persisting PER consumed event — in one atomic
   * unit — a checkpoint (Requirement 5.5 — "a checkpoint per consumed stream
   * event") and a kind='stream' task_event, persisting any artifact event
   * through Managed_Local_Storage, and emitting a task.stream renderer event.
   */
  private async consumeStream(
    taskId: string,
    step: TaskStep,
    handle: AdapterSessionHandle,
    sessionId: string,
    adapter: AgentAdapter,
    attempt: number,
    stopped: () => boolean,
    errorSink?: string[],
  ): Promise<void> {
    for await (const ev of adapter.stream(handle)) {
      if (stopped()) break;
      // Retain stderr so a terminal failure can be classified (quota vs other).
      if (errorSink !== undefined && ev.kind === 'stderr' && typeof ev.data === 'string') errorSink.push(ev.data);
      // Persist an artifact event's blob first so the checkpoint/event can
      // reference its managed-storage id if present.
      const artifactId = this.persistArtifactEvent(ev);
      const usage = this.usage !== undefined ? usageFromEvent(ev) : undefined;
      if (usage !== undefined) {
        try { this.usage!.record({ sessionId, taskId, stepId: step.id, adapterId: handle.adapterId, sample: usage }); }
        catch { /* usage is informational; never fail a step over it */ }
      }
      const quota = this.quota !== undefined ? quotaFromEvent(ev) : undefined;
      if (quota !== undefined) {
        try { this.quota!.record({ adapterId: handle.adapterId, sample: quota }); }
        catch { /* quota is informational; never fail a step over it */ }
      }

      const now = new Date().toISOString();
      const eventId = randomUUID();
      const checkpointId = randomUUID();
      const snapshot = this.minimalResumeSnapshot(
        sessionId,
        handle,
        ev,
        artifactId,
      );

      // WRITE-AHEAD per stream event: the stream task_event and the checkpoint
      // are committed together so a crash resumes mid-step from the last
      // consumed event without re-running the step.
      this.store.transaction((tx) => {
        tx.db
          .prepare(
            `INSERT INTO task_events (id, task_id, step_id, kind, payload, created_at)
             VALUES (?, ?, ?, 'stream', ?, ?)`,
          )
          .run(
            eventId,
            taskId,
            step.id,
            JSON.stringify({
              sessionId,
              attempt,
              kind: ev.kind,
              sequence: ev.sequence,
              data: redact(ev.data),
              at: ev.at,
              ...(artifactId !== undefined ? { artifactId } : {}),
            }),
            now,
          );

        tx.db
          .prepare(
            `INSERT INTO checkpoints (id, task_id, step_id, state, snapshot, verified, created_at)
             VALUES (?, ?, ?, 'RUNNING', ?, 0, ?)`,
          )
          .run(checkpointId, taskId, step.id, JSON.stringify(snapshot), now);
      });

      // Emit the stream event to the renderer (Requirement 5.5 — within 1s of
      // the step state change). The emitter swallows transport errors.
      this.emitter.emit('task.stream', {
        taskId,
        stepId: step.id,
        sequence: ev.sequence,
        kind: ev.kind,
        at: ev.at,
        ...(artifactId !== undefined ? { artifactId } : {}),
      });
    }
  }

  /**
   * Persist an artifact stream event's payload through Managed_Local_Storage and
   * return its blob id, or undefined when the event is not an artifact (or no
   * storage is wired). Artifact payloads are redacted/placeholder-safe by the
   * adapter contract, so storing them verbatim never writes a raw secret.
   */
  private persistArtifactEvent(ev: AdapterStreamEvent): string | undefined {
    if (ev.kind !== 'artifact' || this.storage === undefined) {
      return undefined;
    }
    const blob =
      typeof ev.data === 'string' ? String(redact(ev.data)) : JSON.stringify(redact(ev.data ?? null));
    return this.storage.put(blob, 'application/json').id;
  }

  /**
   * Persist the artifacts a terminal AdapterResult references. The adapter has
   * already written the blobs through Managed_Local_Storage (the ids are in
   * `artifactIds`); we record a kind='artifact' task_event per id so the
   * artifact is linked to the step before the terminal transition runs
   * (Requirement 5.7).
   */
  private persistResultArtifacts(
    taskId: string,
    stepId: string,
    result: AdapterResult,
    sessionId: string,
    attempt: number,
  ): void {
    const ids = [...(result.artifactIds ?? [])];
    const output = result.output;
    if (output !== undefined && this.storage) {
      const blob = this.storage.put(typeof output === 'string' ? String(redact(output)) : JSON.stringify(redact(output)), 'text/plain');
      ids.push(blob.id);
    }
    if (this.storage) {
      const rows = this.store.db.prepare("SELECT payload FROM task_events WHERE task_id=? AND step_id=? AND kind='stream' AND json_extract(payload,'$.kind')='stdout' AND json_extract(payload,'$.sessionId')=? AND json_extract(payload,'$.attempt')=? ORDER BY rowid")
        .all(taskId, stepId, sessionId, attempt) as {payload:string}[];
      const transcript = rows.map((r) => (JSON.parse(r.payload) as {data:unknown}).data).filter((d) => typeof d === 'string').join('\n').slice(0, 2*1024*1024);
      if (transcript) ids.push(this.storage.put(String(redact(transcript)), 'text/plain').id);
    }
    if (ids.length === 0) {
      return;
    }
    const now = new Date().toISOString();
    this.store.transaction((tx) => {
      const insert = tx.db.prepare(
        `INSERT INTO task_events (id, task_id, step_id, kind, payload, created_at)
         VALUES (?, ?, ?, 'artifact', ?, ?)`,
      );
      for (const artifactId of ids) {
        insert.run(randomUUID(), taskId, stepId, JSON.stringify({ artifactId }), now);
      }
    });
  }

  // ---- Persistence helpers ----

  /** Load the task's steps in persisted topological (ordinal) order. */
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

  /** The input handed to an adapter's `start`. */
  private async stepInput(step: TaskStep): Promise<unknown> {
    const row = this.store.db.prepare('SELECT execution_input FROM task_steps WHERE id = ?')
      .get(step.id) as { execution_input: string | null } | undefined;
    const saved = row?.execution_input ? JSON.parse(row.execution_input) as Record<string, unknown> : {};
    const base = this.resolveInput ? await this.resolveInput(step, saved) : saved;
    // A step that depends on others gets their replies, as untrusted
    // reference data, so later waves build on earlier ones.
    if (typeof base['objective'] === 'string' && step.dependsOn.length > 0) {
      const upstream = step.dependsOn.flatMap((depId) => {
        const dep = this.store.db.prepare('SELECT description, assigned_adapter_id FROM task_steps WHERE id = ?')
          .get(depId) as { description: string; assigned_adapter_id: string | null } | undefined;
        if (dep === undefined) return [];
        const reply = stepReply(this.store, step.taskId, depId);
        return [{ kind: 'completed_dependency', task: dep.description, agent: dep.assigned_adapter_id, reply: reply.slice(0, 8000), trust: 'untrusted_reference_data' }];
      });
      const context = Array.isArray(base['contextData']) ? base['contextData'] as unknown[] : [];
      base['contextData'] = [...upstream, ...context];
    }
    return {
      ...base,
      taskId: step.taskId,
      stepId: step.id,
      description: step.description,
      ...(step.inputSchemaRef !== undefined
        ? { inputSchemaRef: step.inputSchemaRef }
        : {}),
    };
  }

  /** Update a step's status and optionally stamp started_at / ended_at. */
  private markStep(
    stepId: string,
    status: TaskStep['status'],
    stamps: { startedAt?: boolean; endedAt?: boolean } = {},
  ): void {
    const now = new Date().toISOString();
    if (stamps.startedAt === true) {
      this.store.db
        .prepare(
          `UPDATE task_steps SET status = ?, started_at = COALESCE(started_at, ?) WHERE id = ?`,
        )
        .run(status, now, stepId);
      return;
    }
    if (stamps.endedAt === true) {
      this.store.db
        .prepare(`UPDATE task_steps SET status = ?, ended_at = ? WHERE id = ?`)
        .run(status, now, stepId);
      return;
    }
    this.store.db
      .prepare(`UPDATE task_steps SET status = ? WHERE id = ?`)
      .run(status, stepId);
  }

  /** Insert the agent_session row for a started adapter invocation. */
  private insertAgentSession(
    taskId: string,
    handle: AdapterSessionHandle,
    stepId: string,
  ): string {
    const id = handle.sessionId;
    const now = new Date().toISOString();
    this.store.db
      .prepare(
        `INSERT INTO agent_sessions
           (id, task_id, adapter_id, external_ref, status, resumable, last_heartbeat_at, exit_code, created_at, step_id)
         VALUES (?, ?, ?, ?, 'live', ?, NULL, NULL, ?, ?)`,
      )
      .run(
        id,
        taskId,
        handle.adapterId,
        handle.externalRef ?? null,
        handle.resumable ? 1 : 0,
        now,
        stepId,
      );
    return id;
  }

  /** Mark an agent_session terminal after it exits/orphans. */
  private markSessionExited(
    sessionId: string,
    status: 'exited' | 'orphaned',
  ): void {
    this.store.db
      .prepare(`UPDATE agent_sessions SET status = ? WHERE id = ?`)
      .run(status, sessionId);
  }

  /** Append a standalone RUNNING checkpoint (used on step success). */
  private checkpoint(
    taskId: string,
    stepId: string,
    state: TaskState,
    snapshot: unknown,
  ): void {
    this.store.db
      .prepare(
        `INSERT INTO checkpoints (id, task_id, step_id, state, snapshot, verified, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        randomUUID(),
        taskId,
        stepId,
        state,
        JSON.stringify(snapshot),
        new Date().toISOString(),
      );
  }

  /** The minimal snapshot sufficient to resume a step mid-stream. */
  private minimalResumeSnapshot(
    sessionId: string,
    handle: AdapterSessionHandle,
    ev: AdapterStreamEvent,
    artifactId: string | undefined,
  ): unknown {
    return {
      sessionId,
      adapterId: handle.adapterId,
      ...(handle.externalRef !== undefined
        ? { externalRef: handle.externalRef }
        : {}),
      resumable: handle.resumable,
      lastSequence: ev.sequence,
      ...(artifactId !== undefined ? { lastArtifactId: artifactId } : {}),
    };
  }

  /** Record a kind='error' task_event for a crashed adapter lifecycle phase. */
  private recordStepError(
    taskId: string,
    stepId: string,
    phase: 'start' | 'stream' | 'await' | 'cancel',
    err: unknown,
  ): void {
    const message = err instanceof Error ? err.message : String(err);
    this.store.db
      .prepare(
        `INSERT INTO task_events (id, task_id, step_id, kind, payload, created_at)
         VALUES (?, ?, ?, 'error', ?, ?)`,
      )
      .run(
        randomUUID(),
        taskId,
        stepId,
        JSON.stringify(redact({ phase, error: message })),
        new Date().toISOString(),
      );
    this.audit.append({
      actor: 'orchestrator',
      action: 'task.step.error',
      target: taskId,
      redactedPayload: { stepId, phase, error: message },
    });
  }

  /** The current persisted step row as a domain TaskStep, or undefined. */
  private stepRow(stepId: string): TaskStep | undefined {
    const row = this.store.db.prepare(
      `SELECT id, task_id, ordinal, description, depends_on, assigned_adapter_id, input_schema_ref, status, started_at, ended_at
       FROM task_steps WHERE id = ?`,
    ).get(stepId) as StepRow | undefined;
    return row === undefined ? undefined : rowToStep(row);
  }

  /**
   * Re-point a step to a different available agent that can fulfil the same
   * objective, when the current one is out of usage/quota or cannot run the
   * selected model. Rewrites the step's assigned adapter and required
   * capability (both namespaced per agent as `objective.fulfill.<id>`) and
   * returns true if an alternate was chosen. Returns false when no untried,
   * available alternate exists.
   */
  private async repointToFallback(task: Task, step: TaskStep, tried: ReadonlySet<string>, kind: FailureKind): Promise<boolean> {
    const row = this.store.db.prepare('SELECT required_capability FROM task_steps WHERE id = ?').get(step.id) as { required_capability: string | null } | undefined;
    const capability = row?.required_capability ?? undefined;
    // Only objective-fulfilment steps carry a per-agent alternate; other
    // capabilities route deterministically and have no provider fallback here.
    if (capability === undefined || !capability.startsWith('objective.fulfill.')) return false;
    const next = this.registry.listAdapters()
      .filter((a) => a.available
        && !tried.has(a.id)
        && a.capabilities.some((c) => c.id === `objective.fulfill.${a.id}`))
      .sort((a, b) => compareAgentPreference(a.id, b.id))[0];
    if (next === undefined) return false;
    this.store.db.prepare('UPDATE task_steps SET assigned_adapter_id = ?, required_capability = ? WHERE id = ?')
      .run(next.id, `objective.fulfill.${next.id}`, step.id);
    this.audit.append({
      actor: 'orchestrator', action: 'task.step.agent_fallback', target: task.id,
      redactedPayload: { stepId: step.id, from: step.assignedAdapterId ?? null, to: next.id, reason: kind },
    });
    const previous = step.assignedAdapterId !== undefined && this.registry.has(step.assignedAdapterId)
      ? this.registry.resolve(step.assignedAdapterId).record.name
      : 'The previous agent';
    const message = kind === 'quota_exhausted'
      ? `${previous} is out of capacity, so ${next.name} is taking over this step.`
      : `${previous} couldn't run the selected model, so ${next.name} is taking over this step.`;
    this.store.db.prepare("INSERT INTO task_events (id, task_id, step_id, kind, payload, created_at) VALUES (?, ?, ?, 'log', ?, ?)")
      .run(randomUUID(), task.id, step.id, JSON.stringify({ message, phase: 'execution', agentFallback: true }), new Date().toISOString());
    this.emitTaskUpdated(task.id);
    return true;
  }

  /**
   * Persist and retry a configured fallback model once for this step/agent.
   * This happens before switching providers so a quota or model outage does
   * not unnecessarily abandon an otherwise suitable CLI.
   */
  private retryWithFallbackModel(
    task: Task,
    step: TaskStep,
    kind: FailureKind,
    tried: Set<string>,
  ): boolean {
    const agentId = step.assignedAdapterId;
    if (agentId === undefined || tried.has(agentId)) return false;
    tried.add(agentId);
    const model = this.fallbackModel?.(agentId);
    if (model === undefined) return false;

    const row = this.store.db.prepare('SELECT execution_input FROM task_steps WHERE id = ?')
      .get(step.id) as { execution_input: string | null } | undefined;
    let input: Record<string, unknown> = {};
    try {
      input = row?.execution_input === null || row?.execution_input === undefined
        ? {} : JSON.parse(row.execution_input) as Record<string, unknown>;
    } catch {
      return false;
    }
    const models = input['models'];
    const currentModels = models !== null && typeof models === 'object' && !Array.isArray(models)
      ? models as Record<string, unknown> : {};
    if (currentModels[agentId] === model) return false;
    this.store.db.prepare('UPDATE task_steps SET execution_input = ? WHERE id = ?')
      .run(JSON.stringify({ ...input, models: { ...currentModels, [agentId]: model } }), step.id);
    this.audit.append({
      actor: 'orchestrator', action: 'task.step.model_fallback', target: task.id,
      redactedPayload: { stepId: step.id, agentId, model, reason: kind },
    });
    this.store.db.prepare("INSERT INTO task_events (id, task_id, step_id, kind, payload, created_at) VALUES (?, ?, ?, 'log', ?, ?)")
      .run(randomUUID(), task.id, step.id, JSON.stringify({
        message: `Retrying ${agentId} with its fallback model.`,
        phase: 'execution',
        modelFallback: true,
        agentId,
        model,
        reason: kind,
      }), new Date().toISOString());
    this.emitTaskUpdated(task.id);
    return true;
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
