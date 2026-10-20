import { randomUUID } from 'node:crypto';
import type { Store } from '../db/types';
import type { AuditLog } from '../domain/audit-log';
import type { WorkspaceService } from '../domain/workspace-service';
import type { UsageRecorder } from '../usage/usage';
import {
  PermissionService,
  type PermissionSubject,
} from '../domain/permission-service';
import { Registry } from '../registry/registry';
import { TaskStateMachine } from './state-machine';
import type { TaskCanceller, CancelTaskResult } from './cancellation';
import {
  PlaceholderContextProvider,
  type ContextProvider,
} from './context-provider';
import {
  PlaceholderPlanner,
  PlanCycleError,
  topologicalSort,
  type Planner,
  type PlannedStep,
  type PlanDecomposition,
} from './planner';
import {
  selectAdapters,
  type FallbackAutomations,
  type HistoricalPerformance,
  type RoutableStep,
  type RoutingDecision,
} from './routing';
import {
  StepExecutor,
  type BackoffClock,
  type ExecuteStepsResult,
  type StepPermissions,
} from './step-executor';
import {
  Verifier,
  type CriterionEvaluator,
  type VerificationClock,
  type VerifyResult,
} from './verifier';
import type { TaskEventEmitter } from './event-emitter';
import type { ManagedStorage } from '../storage/managed-storage';
import type { Task, TaskState } from '@shared/domain';

// The orchestrator's task lifecycle entry points (Requirement 5.1, 5.2, 5.3).
//
// This is the thin lifecycle layer that sits on top of the durable
// TaskStateMachine (the single authority on legal transitions and the
// write-ahead `transition` primitive) and the TaskCanceller. It owns:
//
//   * createTask — persists a brand-new task in CREATED with its transition
//     event and NOTHING else (Requirement 5.1). Validates the objective and
//     workspace first and persists nothing on failure (Requirement 5.2).
//   * beginExecution — the CONTEXT_LOADING placeholder step: transitions
//     CREATED → CONTEXT_LOADING through the write-ahead primitive, loads context
//     through the (placeholder, M4-pending) ContextProvider, persists the
//     resolved context references on the task, then transitions
//     CONTEXT_LOADING → PLANNING and runs planning (Requirement 5.3).
//   * planTask — the PLANNING step (Requirement 5.4, 5.5, 5.6, 5.8): decomposes
//     the objective into a DAG of steps via the (pluggable, placeholder-backed)
//     Planner, topologically sorts it rejecting any cycle, routes each step to
//     exactly one adapter or deterministic fallback via the deterministic
//     capability router (task 10), and — only if the whole plan is routable and
//     acyclic — persists the ordered, routed steps to `task_steps`. A cyclic
//     graph or an unroutable step rejects the plan: NOTHING is persisted and
//     NO step is executed. Planning stops once the routable DAG is persisted;
//     RUNNING execution (task 9.3) is deliberately out of scope here.
//   * getTask / listActive — read models the IPC surface exposes.
//   * cancelTask — delegates to the TaskCanceller (task 8.4).
//
// RUNNING execution and VERIFYING (tasks 9.3–9.4) are deliberately out of scope;
// beginExecution/planTask stop once the persisted plan is ready. Everything this
// layer mutates goes through the state machine's atomic transition so durability
// and legality are never re-implemented.

/** The non-terminal states a task can be in while "active". */
const ACTIVE_STATES: readonly TaskState[] = [
  'CREATED',
  'CONTEXT_LOADING',
  'PLANNING',
  'WAITING_FOR_APPROVAL',
  'RUNNING',
  'VERIFYING',
  'BLOCKED',
  'RECOVERABLE_INTERRUPTION',
];

/** The maximum accepted objective length (Requirement 5.2). */
export const MAX_OBJECTIVE_LENGTH = 10_000;

/**
 * Raised when createTask input fails validation. `field` names the specific
 * failure so the caller (and the IPC error) can point at it (Requirement 5.2).
 */
export class TaskValidationError extends Error {
  constructor(
    readonly field: 'objective' | 'workspaceId' | 'parentTaskId',
    message: string,
  ) {
    super(message);
    this.name = 'TaskValidationError';
  }
}

/**
 * Raised when planning cannot route every step of a decomposition (one or more
 * steps were BLOCKED with no deterministic fallback). `stepIds` names the
 * unroutable steps so the caller and IPC error can point at them
 * (Requirement 5.6). When planning rejects for this reason, NO step is
 * persisted or executed.
 */
export class PlanRoutingError extends Error {
  /** The planner-local ids of the steps that could not be routed. */
  readonly stepIds: readonly string[];
  readonly reasons: readonly (RoutingDecision['reason'])[];
  constructor(stepIds: readonly string[], reasons: readonly (RoutingDecision['reason'])[] = []) {
    super(PlanRoutingError.explain(reasons));
    this.name = 'PlanRoutingError';
    this.stepIds = stepIds;
    this.reasons = reasons;
  }

  /** A user-facing explanation of why no agent could take the task. */
  static explain(reasons: readonly (RoutingDecision['reason'])[]): string {
    if (reasons.includes('permissions_unsatisfiable')) {
      return 'No agent can run under the Read-only permission profile, because agents need to run commands. Allow agents to run (Settings → Execution permissions → Assisted execution asks before each command or file change), then retry.';
    }
    if (reasons.includes('none_available')) {
      return 'The agent for this task is installed but not available right now. Check Connections, then retry.';
    }
    return 'No agent CLI that can run tasks is installed. Install one in Connections (for example Codex CLI), then retry.';
  }
}

// Re-export the planning DAG error so callers that catch planning failures do
// not need to import from two modules.
export { PlanCycleError } from './planner';

export interface CreateTaskInput {
  workspaceId: string;
  objective: string;
  /** Optional acceptance criteria; defaults to an empty list for now. */
  acceptanceCriteria?: readonly string[];
  /**
   * The previous task in a conversation thread. The new task joins that
   * thread; it must belong to the same workspace.
   */
  parentTaskId?: string;
}

export interface OrchestratorOptions {
  /**
   * The context provider used on the CONTEXT_LOADING step. Defaults to the
   * M1–M3 placeholder that loads no external context (the real Context Engine
   * lands in M4 / task 16).
   */
  contextProvider?: ContextProvider;
  /**
   * The planner used on the PLANNING step to decompose an objective into a DAG
   * of steps. Defaults to the M1–M3 placeholder that produces a single step
   * (the real LLM-driven planner lands later).
   */
  planner?: Planner;
  /**
   * The registry routing consults for adapters that declare a step's
   * capability. Required for planning to route steps; when omitted the
   * orchestrator uses an empty registry (so every step is unroutable), which is
   * only useful in create/begin tests that never reach a routable plan.
   */
  registry?: Registry;
  executionInput?: (task: Task, step: PlannedStep) => unknown;
  /**
   * The permission service routing consults to decide whether a candidate
   * adapter's permissions are satisfiable under the active profile. Required
   * alongside `registry` for real routing.
   */
  permissions?: PermissionService;
  /**
   * The permission subject whose grants gate routing eligibility. Defaults to a
   * generic orchestrator agent subject.
   */
  routingSubject?: PermissionSubject;
  /**
   * Optional historical-performance oracle passed through to routing. Must be a
   * pure function of its inputs so planning stays deterministic.
   */
  historicalPerformance?: HistoricalPerformance;
  /**
   * Optional capability → deterministic-automation fallback map passed through
   * to routing. A step whose capability has no eligible adapter but appears
   * here is routed to the fallback instead of being treated as unroutable
   * (Requirement 5.5 — "a compatible adapter OR deterministic automation").
   */
  fallbackAutomations?: FallbackAutomations;
  /**
   * Managed_Local_Storage for persisting artifacts streamed/returned during
   * RUNNING step execution (task 9.3). Optional; when omitted, artifact stream
   * events are not blob-persisted (only linked).
   */
  storage?: ManagedStorage;
  /**
   * The renderer event-emit seam used during RUNNING execution to stream
   * task.updated / task.stream events (Requirement 5.5). Defaults to a no-op so
   * headless execution never depends on a renderer.
   */
  emitter?: TaskEventEmitter;
  /**
   * Backoff seam for bounded step retries. Defaults to the host timer; tests
   * inject a fake that resolves immediately.
   */
  backoffClock?: BackoffClock;
  /**
   * Resolver for a persisted step's declared permission requirements, used by
   * the approval gate during RUNNING execution (Requirement 9.2).
   */
  stepPermissions?: StepPermissions;
  /** Max bounded retries per step during RUNNING execution. */
  maxStepRetries?: number;
  /** Base backoff (ms) before the first step retry. */
  baseStepBackoffMs?: number;
  /**
   * The per-criterion evaluator the VERIFYING pass (task 9.4) uses to decide
   * whether each acceptance criterion is satisfied. Defaults to the
   * conservative evaluator that fails every criterion (so no task with
   * acceptance criteria completes without real verification logic wired in —
   * Property 3).
   */
  criterionEvaluator?: CriterionEvaluator;
  /**
   * Monotonic clock driving the 300-second verification timeout. Defaults to
   * the host timer; tests inject a fake that advances deterministically.
   */
  verificationClock?: VerificationClock;
  /** Verification timeout in ms. Defaults to 300_000 (Requirement 7.5). */
  verificationTimeoutMs?: number;
  /** Most steps of one task that run at the same time (default 4). */
  maxParallelSteps?: number;
  /** Records token usage reported by agents. */
  usage?: UsageRecorder;
  /** Called after each step settles. */
  onStepSettled?: (taskId: string, stepId: string) => void;
  resolveInput?: import('./step-executor').StepExecutorOptions['resolveInput'];
  fallbackModel?: import('./step-executor').StepExecutorOptions['fallbackModel'];
}

/** The default routing subject when none is injected. */
const DEFAULT_ROUTING_SUBJECT: PermissionSubject = {
  type: 'agent',
  id: 'orchestrator',
};

export class Orchestrator {
  private readonly contextProvider: ContextProvider;
  private readonly planner: Planner;
  private readonly registry: Registry;
  private readonly executionInput: ((task: Task, step: PlannedStep) => unknown) | undefined;
  private readonly permissions: PermissionService;
  private readonly routingSubject: PermissionSubject;
  private readonly historicalPerformance: HistoricalPerformance | undefined;
  private readonly fallbackAutomations: FallbackAutomations | undefined;
  private readonly stepExecutor: StepExecutor;
  private readonly verifier: Verifier;

  constructor(
    private readonly store: Store,
    private readonly stateMachine: TaskStateMachine,
    private readonly workspaces: WorkspaceService,
    private readonly canceller: TaskCanceller,
    private readonly audit: AuditLog,
    options: OrchestratorOptions = {},
  ) {
    this.contextProvider =
      options.contextProvider ?? new PlaceholderContextProvider();
    this.planner = options.planner ?? new PlaceholderPlanner();
    // Routing needs a registry and a permission service. Defaulting to an empty
    // registry means every step is unroutable (only useful in create/begin
    // tests that never reach a routable plan); a lazily-built permission
    // service lets routing evaluate permission-free steps without external
    // wiring. Real composition (bootstrap) injects both.
    this.registry = options.registry ?? new Registry();
    this.executionInput = options.executionInput;
    this.permissions =
      options.permissions ?? new PermissionService(store, audit);
    this.routingSubject = options.routingSubject ?? DEFAULT_ROUTING_SUBJECT;
    this.historicalPerformance = options.historicalPerformance;
    this.fallbackAutomations = options.fallbackAutomations;

    // The RUNNING step-execution engine (task 9.3). It shares the same store,
    // state machine, registry, permission service, and audit log so every
    // durable write still goes through the write-ahead primitive, and it reuses
    // the orchestrator's routing subject for approval gating.
    this.stepExecutor = new StepExecutor(
      store,
      stateMachine,
      this.registry,
      this.permissions,
      audit,
      {
        ...(options.storage !== undefined ? { storage: options.storage } : {}),
        ...(options.emitter !== undefined ? { emitter: options.emitter } : {}),
        ...(options.backoffClock !== undefined
          ? { backoffClock: options.backoffClock }
          : {}),
        ...(options.stepPermissions !== undefined
          ? { stepPermissions: options.stepPermissions }
          : {}),
        subject: this.routingSubject,
        ...(options.maxStepRetries !== undefined
          ? { maxRetries: options.maxStepRetries }
          : {}),
        ...(options.baseStepBackoffMs !== undefined
          ? { baseBackoffMs: options.baseStepBackoffMs }
          : {}),
        ...(options.maxParallelSteps !== undefined ? { maxParallel: options.maxParallelSteps } : {}),
        ...(options.usage !== undefined ? { usage: options.usage } : {}),
        ...(options.resolveInput !== undefined ? { resolveInput: options.resolveInput } : {}),
        ...(options.onStepSettled !== undefined ? { onStepSettled: options.onStepSettled } : {}),
        ...(options.fallbackModel !== undefined ? { fallbackModel: options.fallbackModel } : {}),
      },
    );

    // The VERIFYING pass (task 9.4). It shares the same store, state machine,
    // and audit log so the VERIFYING → {COMPLETED | FAILED |
    // RECOVERABLE_INTERRUPTION} decision goes through the same write-ahead
    // primitive. The per-criterion evaluator, the 300-second timeout clock, and
    // the renderer emit are injectable; defaults uphold Property 3 headlessly.
    this.verifier = new Verifier(stateMachine, audit, {
      ...(options.criterionEvaluator !== undefined
        ? { evaluator: options.criterionEvaluator }
        : {}),
      ...(options.verificationClock !== undefined
        ? { clock: options.verificationClock }
        : {}),
      ...(options.emitter !== undefined ? { emitter: options.emitter } : {}),
      ...(options.verificationTimeoutMs !== undefined
        ? { timeoutMs: options.verificationTimeoutMs }
        : {}),
    });
  }

  /**
   * Create a task (Requirement 5.1, 5.2).
   *
   * Validates the objective (non-empty after trim, at most 10,000 characters)
   * and that the workspace exists, rejecting with a field-specific
   * {@link TaskValidationError} and persisting NOTHING on failure. On success
   * the task is persisted in CREATED together with its `transition` event and a
   * checkpoint, committed atomically — and no other side effect runs.
   *
   * The CREATED row is inserted and then advanced to CREATED via the state
   * machine so the transition event is recorded exactly like every other
   * transition. (The initial INSERT carries state=CREATED; a self-referential
   * "created" transition event is appended so the task's event stream opens
   * with a transition, matching Requirement 5.1's "corresponding transition
   * event".)
   */
  async createTask(input: CreateTaskInput): Promise<Task> {
    const objective = input.objective.trim();
    if (objective.length < 1) {
      throw new TaskValidationError('objective', 'Objective must not be empty');
    }
    if (objective.length > MAX_OBJECTIVE_LENGTH) {
      throw new TaskValidationError(
        'objective',
        `Objective must be at most ${MAX_OBJECTIVE_LENGTH} characters`,
      );
    }

    const workspace = this.workspaces.get(input.workspaceId);
    if (workspace === undefined) {
      throw new TaskValidationError(
        'workspaceId',
        `Workspace ${input.workspaceId} not found`,
      );
    }

    let threadId: string | undefined;
    if (input.parentTaskId !== undefined) {
      const parent = this.stateMachine.getTask(input.parentTaskId);
      if (parent === undefined || parent.workspaceId !== input.workspaceId) {
        throw new TaskValidationError('parentTaskId', 'The thread being continued was not found in this project');
      }
      threadId = parent.threadId ?? parent.id;
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const acceptanceCriteria = [...(input.acceptanceCriteria ?? [])];
    const eventId = randomUUID();
    const checkpointId = randomUUID();

    // Persist the CREATED task, its opening `transition` event, and the initial
    // checkpoint as one atomic unit. This mirrors the write-ahead primitive's
    // guarantee (event + state + checkpoint committed together) for the very
    // first state, and performs no side effect beyond persistence
    // (Requirement 5.1).
    this.store.transaction((tx) => {
      tx.db
        .prepare(
          `INSERT INTO tasks (id, workspace_id, objective, acceptance_criteria,
                              state, context_refs, thread_id, parent_task_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'CREATED', '[]', ?, ?, ?, ?)`,
        )
        .run(id, input.workspaceId, objective, JSON.stringify(acceptanceCriteria),
          threadId ?? id, input.parentTaskId ?? null, now, now);

      tx.db
        .prepare(
          `INSERT INTO task_events (id, task_id, step_id, kind, payload, created_at)
           VALUES (?, ?, NULL, 'transition', ?, ?)`,
        )
        .run(
          eventId,
          id,
          JSON.stringify({ from: null, to: 'CREATED', reason: 'created' }),
          now,
        );

      tx.db
        .prepare(
          `INSERT INTO checkpoints (id, task_id, step_id, state, snapshot, verified, created_at)
           VALUES (?, ?, NULL, 'CREATED', ?, 0, ?)`,
        )
        .run(checkpointId, id, JSON.stringify(null), now);
    });

    const task = this.stateMachine.getTask(id);
    if (task === undefined) {
      // Should be unreachable: the insert above committed.
      throw new Error(`Task ${id} was not persisted`);
    }
    return task;
  }

  /**
   * Begin executing a created task: the CONTEXT_LOADING placeholder step
   * (Requirement 5.3).
   *
   * Order is load-bearing and goes entirely through the write-ahead primitive:
   *   1. CREATED → CONTEXT_LOADING (durable transition committed first).
   *   2. Load context via the ContextProvider (placeholder until M4). This is
   *      the one side effect of the CONTEXT_LOADING state, and it runs only
   *      after the transition committed.
   *   3. Persist the resolved context reference ids on the task.
   *   4. CONTEXT_LOADING → PLANNING so planning (task 9.2) can take over.
   *
   * After reaching PLANNING this runs {@link planTask}, which decomposes,
   * routes, and persists the plan. Returns the task's state after planning
   * completes (PLANNING once the routable DAG is persisted; RUNNING execution
   * is task 9.3). A cyclic or unroutable plan leaves the task in PLANNING and
   * the error propagates to the caller with no step persisted.
   */
  async beginExecution(taskId: string, plan?: PlanDecomposition): Promise<TaskState> {
    const task = this.stateMachine.getTask(taskId);
    if (task === undefined) {
      throw new Error(`Task ${taskId} not found`);
    }

    // 1. Durable transition into CONTEXT_LOADING before any context side effect.
    this.stateMachine.transition({
      taskId,
      to: 'CONTEXT_LOADING',
      eventPayload: { reason: 'start' },
    });

    // 2. Load context (placeholder provider loads nothing in M1–M3).
    const bundle = await this.contextProvider.retrieveContext({
      taskId,
      workspaceId: task.workspaceId,
      objective: task.objective,
    });
    const refs = [...bundle.refs];

    // 3. Persist resolved context references on the task.
    this.store.db
      .prepare(`UPDATE tasks SET context_refs = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(refs), new Date().toISOString(), taskId);

    this.audit.append({
      actor: 'orchestrator',
      action: 'task.context.loaded',
      target: taskId,
      redactedPayload: { refCount: refs.length },
    });

    // 4. Durable transition into PLANNING (ctx-loaded).
    this.stateMachine.transition({
      taskId,
      to: 'PLANNING',
      snapshot: { contextRefs: refs },
      eventPayload: { reason: 'ctx-loaded' },
    });

    // 5. Plan: decompose into a routed DAG and persist it (Requirement 5.4–5.8).
    //    planTask leaves the task in PLANNING once the plan is persisted; it
    //    throws (and persists nothing) on a cyclic or unroutable plan.
    return this.planTask(taskId, plan);
  }

  /**
   * The PLANNING step (Requirement 5.4, 5.5, 5.6, 5.8).
   *
   * The task is expected to be in PLANNING (reached via {@link beginExecution}).
   * This method:
   *   1. decomposes the objective into one or more steps with declared
   *      dependencies via the pluggable Planner (Requirement 5.4),
   *   2. topologically sorts the decomposition, rejecting a cyclic dependency
   *      graph — nothing is persisted and the thrown {@link PlanCycleError}
   *      names the cycle (Requirement 5.8),
   *   3. routes each step to exactly one compatible adapter or deterministic
   *      fallback via the deterministic capability router, without any user
   *      agent selection (Requirement 5.5); if ANY step is unroutable (BLOCKED
   *      with no fallback) it rejects the whole plan with a
   *      {@link PlanRoutingError} naming the step(s) and persists/executes
   *      nothing (Requirement 5.6),
   *   4. only when the whole plan is acyclic AND fully routable, persists the
   *      ordered, routed steps to `task_steps` in one atomic transaction.
   *
   * RUNNING execution is NOT performed here — planning stops once the routable
   * DAG is persisted (task 9.3 takes over). The task stays in PLANNING.
   *
   * Validation ordering is load-bearing: the cycle check runs BEFORE routing
   * and routing runs BEFORE any persistence, so neither a cyclic nor an
   * unroutable plan ever leaves a partial DAG behind.
   */
  async planTask(taskId: string, plan?: PlanDecomposition): Promise<TaskState> {
    const task = this.stateMachine.getTask(taskId);
    if (task === undefined) {
      throw new Error(`Task ${taskId} not found`);
    }

    // 1. Decompose the objective into the planner's steps.
    const decomposition = plan ?? await this.planner.decompose({
      taskId,
      workspaceId: task.workspaceId,
      objective: task.objective,
      contextRefs: task.contextRefs,
      acceptanceCriteria: task.acceptanceCriteria,
    });

    // 2. Topologically sort — rejects a cycle (and malformed deps) by throwing,
    //    before anything is routed or persisted (Requirement 5.8).
    let ordered: PlannedStep[];
    try {
      ordered = topologicalSort(decomposition);
    } catch (err) {
      if (err instanceof PlanCycleError) {
        this.audit.append({
          actor: 'orchestrator',
          action: 'task.plan.rejected',
          target: taskId,
          redactedPayload: { reason: 'cyclic', cycle: err.cycle },
        });
      }
      throw err;
    }

    // 3. Route every step deterministically (Requirement 5.5). Routing maps the
    //    planner-local step ids to RoutableSteps; decisions come back in input
    //    order aligned 1:1 with `ordered`.
    const routable: RoutableStep[] = ordered.map((step) => ({
      id: step.id,
      requiredCapability: step.requiredCapability,
      ...(step.requiredPermissions !== undefined
        ? { requiredPermissions: step.requiredPermissions }
        : {}),
    }));

    const decisions = selectAdapters({
      steps: routable,
      registry: this.registry,
      permissions: this.permissions,
      subject: this.routingSubject,
      ...(this.historicalPerformance !== undefined
        ? { historicalPerformance: this.historicalPerformance }
        : {}),
      ...(this.fallbackAutomations !== undefined
        ? { fallbackAutomations: this.fallbackAutomations }
        : {}),
    });

    // Any BLOCKED decision makes the whole plan unroutable: reject naming the
    // step(s), persist nothing, execute nothing (Requirement 5.6).
    const blocked = decisions.filter((d) => d.kind === 'blocked');
    if (blocked.length > 0) {
      const stepIds = blocked.map((d) => d.stepId);
      this.audit.append({
        actor: 'orchestrator',
        action: 'task.plan.rejected',
        target: taskId,
        redactedPayload: {
          reason: 'unroutable',
          stepIds,
          reasons: blocked.map((d) => ({ stepId: d.stepId, reason: d.reason })),
        },
      });
      throw new PlanRoutingError(stepIds, blocked.map((d) => d.reason));
    }

    // 4. The plan is acyclic and fully routable. Persist the ordered, routed
    //    steps to task_steps atomically. Each persisted step carries its
    //    topological ordinal, resolved dependency ids, and the adapter routing
    //    assigned (or none, for a deterministic-fallback step).
    const decisionByStepId = new Map<string, RoutingDecision>(
      decisions.map((d) => [d.stepId, d]),
    );
    // Map planner-local ids to the durable step ids minted here so persisted
    // depends_on references the durable ids.
    const durableIdByPlannerId = new Map<string, string>();
    for (const step of ordered) {
      durableIdByPlannerId.set(step.id, randomUUID());
    }

    // Resolve asynchronous content before opening the synchronous SQL transaction.
    const executionInputs = new Map<string, unknown>();
    for (const step of ordered) executionInputs.set(step.id, await this.executionInput?.(task, step));
    this.store.transaction((tx) => {
      const insert = tx.db.prepare(
        `INSERT INTO task_steps
           (id, task_id, ordinal, description, depends_on,
            assigned_adapter_id, input_schema_ref, status, started_at, ended_at,
            required_capability, required_permissions, execution_input)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 'pending', NULL, NULL, ?, ?, ?)`,
      );
      ordered.forEach((step, index) => {
        const durableId = durableIdByPlannerId.get(step.id)!;
        const dependsOn = (step.dependsOn ?? []).map(
          (depPlannerId) => durableIdByPlannerId.get(depPlannerId)!,
        );
        const decision = decisionByStepId.get(step.id);
        const assignedAdapterId =
          decision?.kind === 'assigned'
            ? (decision.assignedAdapterId ?? null)
            : null;
        insert.run(
          durableId,
          taskId,
          index,
          step.description,
          JSON.stringify(dependsOn),
          assignedAdapterId,
          step.requiredCapability,
          JSON.stringify([
            ...(step.requiredPermissions ?? []),
            ...(assignedAdapterId === null ? [] :
              this.registry.resolve(assignedAdapterId).record.capabilities
                .find((c) => c.id === step.requiredCapability)?.requiredPermissions ?? []),
          ]),
          step.input === undefined && this.executionInput === undefined ? null :
            JSON.stringify(mergeStepInput(executionInputs.get(step.id), step.input)),
        );
      });
    });

    this.audit.append({
      actor: 'orchestrator',
      action: 'task.plan.ready',
      target: taskId,
      redactedPayload: {
        stepCount: ordered.length,
        assignments: decisions.map((d) => ({
          stepId: d.stepId,
          kind: d.kind,
          ...(d.assignedAdapterId !== undefined
            ? { adapterId: d.assignedAdapterId }
            : {}),
          ...(d.fallbackAutomationId !== undefined
            ? { fallbackAutomationId: d.fallbackAutomationId }
            : {}),
        })),
      },
    });

    // Planning stops here: the routable DAG is persisted and the task stays in
    // PLANNING. RUNNING execution (task 9.3) advances it from here.
    const planned = this.stateMachine.getTask(taskId);
    return planned?.state ?? task.state;
  }

  /**
   * The RUNNING step-execution step (Requirement 5.5, 5.7; 9.2) — task 9.3.
   *
   * The task is expected to be in PLANNING with a routed DAG already persisted
   * in `task_steps` (reached via {@link planTask}). This delegates to the
   * {@link StepExecutor}, which:
   *   * gates an approval-requiring step through WAITING_FOR_APPROVAL before any
   *     adapter runs (Requirement 9.2), suspending there,
   *   * otherwise transitions PLANNING → RUNNING, executes the steps in
   *     dependency (topological) order skipping already-succeeded steps,
   *     streams progress events to the renderer within one second of each step
   *     state change, and persists a checkpoint per consumed stream event
   *     (Requirement 5.5),
   *   * persists collected artifacts via Managed_Local_Storage before any
   *     terminal transition and enforces bounded retries with backoff
   *     (Requirement 5.7),
   *   * transitions RUNNING → VERIFYING once every step has succeeded.
   *
   * It stops at the VERIFYING transition — verification itself is task 9.4.
   */
  runSteps(taskId: string): Promise<ExecuteStepsResult> {
    return this.stepExecutor.executeSteps(taskId);
  }

  /**
   * The VERIFYING step (Requirement 7.1–7.6; Property 3) — task 9.4.
   *
   * The task is expected to be in VERIFYING, reached via {@link runSteps} once
   * every step has succeeded (or a step failed and execution handed VERIFYING
   * the decision). This delegates to the {@link Verifier}, which:
   *   * evaluates the task's results against each acceptance criterion,
   *     producing a per-criterion pass/fail outcome (Requirement 7.1);
   *   * transitions VERIFYING → COMPLETED only when every criterion is
   *     satisfied, writing a VERIFIED checkpoint that references the
   *     verification outcome (Requirement 7.2, 7.6) — an adapter exit code of 0
   *     is never by itself sufficient (Requirement 7.3);
   *   * transitions VERIFYING → FAILED recording which criteria were not
   *     satisfied when any criterion fails (Requirement 7.4);
   *   * transitions VERIFYING → RECOVERABLE_INTERRUPTION recording that
   *     verification did not finish when the 300-second timeout is exceeded
   *     (Requirement 7.5).
   *
   * Every durable write goes through the write-ahead state machine.
   */
  verifyTask(taskId: string): Promise<VerifyResult> {
    return this.verifier.verify(taskId);
  }

  /** Load a task by id, or `undefined` when it does not exist. */
  getTask(taskId: string): Task | undefined {
    return this.stateMachine.getTask(taskId);
  }

  /**
   * Every active (non-terminal) task, newest first. "Active" excludes the three
   * terminal states (COMPLETED, FAILED, CANCELLED).
   */
  listActive(): Task[] {
    const placeholders = ACTIVE_STATES.map(() => '?').join(', ');
    const rows = this.store.db
      .prepare(
        `SELECT id, workspace_id, objective, acceptance_criteria, state,
                context_refs, recommended_next_action,
                last_verified_checkpoint_id, thread_id, parent_task_id, created_at, updated_at
         FROM tasks
         WHERE state IN (${placeholders})
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(...ACTIVE_STATES) as TaskRow[];
    return rows.map(rowToTask);
  }

  /** Cancel a non-terminal task, delegating to the TaskCanceller (task 8.4). */
  cancelTask(taskId: string): Promise<CancelTaskResult> {
    return this.canceller.cancelTask(taskId);
  }
}

/**
 * A planner may give a step its own input (plan mode gives each task its own
 * objective). Object inputs are layered over the base execution input, so the
 * step still gets the workspace root, permission mode, models and context;
 * any other input replaces it.
 */
function mergeStepInput(base: unknown, input: unknown): unknown {
  if (input === undefined) return base;
  const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isObject(input) || !isObject(base)) return input;
  return { ...base, ...input };
}

// ---- Row mapping (listActive reads tasks directly for the IN (...) filter) ----

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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
