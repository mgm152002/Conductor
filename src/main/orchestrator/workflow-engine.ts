import { randomUUID } from 'node:crypto';
import type { Store } from '../db/types';
import {
  MAX_WORKFLOW_STEPS,
  type DagWorkflow,
  type WorkflowCriterionResult,
  type WorkflowErrorRecovery,
  type WorkflowRunResult,
  type WorkflowRunStatus,
  type WorkflowStep,
  type WorkflowStepHistoryEntry,
  type WorkflowStepOutcome,
  type WorkflowStepPolicy,
  type WorkflowTestReport,
} from '@shared/domain';
import { validateWorkflowGraph } from './workflow-graph';

// The Workflow DAG engine (Requirement 15, Milestone M6).
//
// This service owns the lifecycle of a DAG_Workflow: validate-and-save (with
// versioning that retains prior versions), retrieve any version, test a
// workflow against its validation criteria within the 60-second budget, and
// execute a workflow in dependency order while enforcing bounded loops, retry,
// and timeout policies and applying the error-recovery policy when a step
// exhausts its retries.
//
// Graph validation (cycle rejection, the 500-step bound, dangling/duplicate
// ids) is the pure `validateWorkflowGraph` from `workflow-graph.ts`, which
// mirrors the intra-task planner's topological sort. Execution is driven
// through an injectable `WorkflowStepRunner` seam so the engine's ordering,
// loop/retry/timeout accounting, and error-recovery logic are deterministic and
// testable without real adapters — the same pattern the orchestrator uses for
// the `Planner` seam.

/** Engine defaults applied to a step that declares no policy of its own. */
export const DEFAULT_STEP_POLICY: WorkflowStepPolicy = {
  maxRetries: 0,
  timeoutMs: 30_000,
};

/** The default error-recovery policy when neither step nor workflow sets one. */
export const DEFAULT_ERROR_RECOVERY: WorkflowErrorRecovery = { kind: 'abort' };

/** The reporting budget for a workflow test run (Requirement 15.4). */
export const WORKFLOW_TEST_BUDGET_MS = 60_000;

export class WorkflowValidationError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowValidationError';
  }
}

export class WorkflowNotFoundError extends Error {
  constructor(
    readonly workflowId: string,
    readonly version?: number,
  ) {
    super(
      version === undefined
        ? `Workflow ${workflowId} not found`
        : `Workflow ${workflowId} version ${version} not found`,
    );
    this.name = 'WorkflowNotFoundError';
  }
}

/** Input for creating the first version of a workflow or editing into a new one. */
export interface SaveWorkflowInput {
  /** Stable id shared across versions. Omit to mint a new workflow. */
  workflowId?: string;
  name: string;
  triggers?: DagWorkflow['triggers'];
  inputSchema?: unknown;
  outputSchema?: unknown;
  requiredContext?: string[];
  steps: WorkflowStep[];
  validationCriteria?: DagWorkflow['validationCriteria'];
  errorRecovery?: WorkflowErrorRecovery;
  memoryUpdates?: DagWorkflow['memoryUpdates'];
}

/**
 * The outcome of a single step attempt reported by a {@link WorkflowStepRunner}.
 * `durationMs` lets the engine enforce the per-step timeout deterministically
 * without wall-clock flakiness: a runner reports how long the attempt took and
 * the engine compares it to the policy.
 */
export interface StepAttemptResult {
  ok: boolean;
  durationMs: number;
  detail?: string;
}

/**
 * Context handed to the runner for one step attempt. `variables` is the run's
 * mutable scope — the engine reads branch/loop expressions from it and the
 * runner may read it to decide an outcome. `iteration` is the 1-based loop
 * iteration (1 for ordinary steps). `attempt` is the 1-based attempt number.
 */
export interface StepRunContext {
  readonly step: WorkflowStep;
  readonly iteration: number;
  readonly attempt: number;
  readonly variables: Record<string, unknown>;
}

/**
 * The seam the engine executes each step attempt through. Implementations must
 * resolve (never reject) for a well-formed request so a step failure is modeled
 * as `ok: false` rather than an unhandled throw, keeping execution accounting
 * deterministic.
 */
export interface WorkflowStepRunner {
  run(context: StepRunContext): Promise<StepAttemptResult>;
}

/**
 * A validation-criterion evaluator used by {@link WorkflowEngine.test}. Returns
 * one pass/fail result per criterion. Injectable so tests can drive both
 * outcomes deterministically; a real evaluator runs the workflow in a sandbox.
 */
export interface WorkflowValidator {
  evaluate(workflow: DagWorkflow): Promise<WorkflowCriterionResult[]>;
}

interface WorkflowRow {
  id: string;
  workflow_id: string;
  version: number;
  name: string;
  definition: string;
  created_at: string;
}

export class WorkflowEngine {
  constructor(
    private readonly store: Store,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Validate and save a workflow. Rejects a cyclic graph (naming the offending
   * steps) or a graph over 500 steps before persisting anything
   * (Requirement 15.2). Assigns a new monotonically increasing version within
   * the `workflowId`, retaining all prior versions (Requirement 15.3). When
   * `workflowId` is omitted a new workflow is minted at version 1.
   */
  save(input: SaveWorkflowInput): DagWorkflow {
    const name = input.name.trim();
    if (name.length < 1 || name.length > 255) {
      throw new WorkflowValidationError(
        'name',
        'Workflow name must be between 1 and 255 characters',
      );
    }

    // Validate the graph up front. validateWorkflowGraph throws a precise,
    // named error for cycles, the >500 bound, dangling deps, and duplicates;
    // we surface those unchanged so the caller can name the offending steps.
    validateWorkflowGraph(input.steps);

    const errorRecovery = input.errorRecovery ?? DEFAULT_ERROR_RECOVERY;
    this.assertRecoveryTargetsExist(input.steps, errorRecovery);

    const workflowId = input.workflowId ?? randomUUID();
    const now = this.clock().toISOString();

    return this.store.transaction((tx) => {
      const prior = tx.db
        .prepare(
          'SELECT MAX(version) AS max FROM workflows WHERE workflow_id = ?',
        )
        .get(workflowId) as { max: number | null };

      // When a workflowId was supplied it must already exist; editing a
      // workflow that was never created is a not-found, not a silent create.
      if (input.workflowId !== undefined && prior.max === null) {
        throw new WorkflowNotFoundError(input.workflowId);
      }

      const version = (prior.max ?? 0) + 1;
      const workflow: DagWorkflow = {
        id: randomUUID(),
        workflowId,
        version,
        name,
        triggers: input.triggers ?? [],
        inputSchema: input.inputSchema ?? null,
        outputSchema: input.outputSchema ?? null,
        requiredContext: input.requiredContext ?? [],
        steps: input.steps,
        validationCriteria: input.validationCriteria ?? [],
        errorRecovery,
        memoryUpdates: input.memoryUpdates ?? [],
        createdAt: now,
      };

      tx.db
        .prepare(
          `INSERT INTO workflows (id, workflow_id, version, name, definition, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          workflow.id,
          workflow.workflowId,
          workflow.version,
          workflow.name,
          JSON.stringify(workflow),
          workflow.createdAt,
        );

      return workflow;
    });
  }

  /** Retrieve a specific version, or the latest when `version` is omitted. */
  get(workflowId: string, version?: number): DagWorkflow {
    const row =
      version === undefined
        ? (this.store.db
            .prepare(
              `SELECT * FROM workflows WHERE workflow_id = ?
               ORDER BY version DESC LIMIT 1`,
            )
            .get(workflowId) as WorkflowRow | undefined)
        : (this.store.db
            .prepare(
              'SELECT * FROM workflows WHERE workflow_id = ? AND version = ?',
            )
            .get(workflowId, version) as WorkflowRow | undefined);
    if (row === undefined) {
      throw new WorkflowNotFoundError(workflowId, version);
    }
    return JSON.parse(row.definition) as DagWorkflow;
  }

  /** All retained versions of a workflow, ascending by version. */
  listVersions(workflowId: string): DagWorkflow[] {
    const rows = this.store.db
      .prepare(
        'SELECT * FROM workflows WHERE workflow_id = ? ORDER BY version ASC',
      )
      .all(workflowId) as WorkflowRow[];
    return rows.map((r) => JSON.parse(r.definition) as DagWorkflow);
  }

  /**
   * Test a workflow against its validation criteria and report a pass/fail per
   * criterion within 60 seconds (Requirement 15.4). The evaluator does the
   * actual checking; the engine enforces the budget by aborting with a failing
   * result for every unreported criterion if the evaluator overruns.
   */
  async test(
    workflowId: string,
    validator: WorkflowValidator,
    version?: number,
  ): Promise<WorkflowTestReport> {
    const workflow = this.get(workflowId, version);
    const startedAt = this.clock().getTime();

    const budget = new Promise<'timeout'>((resolvePromise) => {
      setTimeout(() => resolvePromise('timeout'), WORKFLOW_TEST_BUDGET_MS);
    });
    const evaluation = validator.evaluate(workflow);

    const raced = await Promise.race([evaluation, budget]);
    const durationMs = this.clock().getTime() - startedAt;

    let results: WorkflowCriterionResult[];
    if (raced === 'timeout') {
      // Budget blown: report every criterion as a failure naming the timeout so
      // the caller still gets a complete per-criterion report (Requirement 15.4).
      results = workflow.validationCriteria.map((c) => ({
        criterionId: c.id,
        outcome: 'fail' as const,
        detail: `Validation did not complete within ${WORKFLOW_TEST_BUDGET_MS}ms`,
      }));
    } else {
      results = raced;
    }

    return {
      workflowId: workflow.workflowId,
      version: workflow.version,
      durationMs,
      results,
    };
  }

  /**
   * Execute a workflow in dependency order (Requirement 15.5). Each step starts
   * only after all of its dependencies complete. For every executed step (and
   * every loop iteration) an execution-history entry is recorded with start/end
   * times and outcome. Bounded loops terminate at their max iteration count,
   * failing steps retry up to their max retry count, and any attempt exceeding
   * its timeout is aborted; a step that exhausts its retries triggers the
   * error-recovery policy, whose action is recorded (Requirements 15.6, 15.7).
   */
  async run(
    workflowId: string,
    runner: WorkflowStepRunner,
    options: { version?: number; variables?: Record<string, unknown> } = {},
  ): Promise<WorkflowRunResult> {
    const workflow = this.get(workflowId, options.version);
    const ordered = validateWorkflowGraph(workflow.steps);
    const variables: Record<string, unknown> = { ...(options.variables ?? {}) };

    const history: WorkflowStepHistoryEntry[] = [];
    const succeeded = new Set<string>();
    const skipped = new Set<string>();
    let status: WorkflowRunStatus = 'completed';
    const startedAt = this.clock().toISOString();

    outer: for (const step of ordered) {
      // A dependency that was skipped or failed-and-not-recovered means this
      // step is unreachable; record it as skipped and move on.
      const unmetDependency = step.dependsOn.some(
        (dep) => !succeeded.has(dep),
      );
      if (unmetDependency) {
        history.push(this.skipEntry(step, 'dependency not satisfied'));
        skipped.add(step.id);
        continue;
      }

      const policy = step.policy ?? DEFAULT_STEP_POLICY;
      const recovery = step.errorRecovery ?? workflow.errorRecovery;
      const iterations = step.loop ? step.loop.maxIterations : 1;

      let stepFailed = false;
      for (let iteration = 1; iteration <= iterations; iteration += 1) {
        // Bounded loop guard: stop once the continue condition goes false.
        if (
          step.loop &&
          iteration > 1 &&
          !this.truthy(variables[step.loop.continueWhile])
        ) {
          break;
        }

        const { entry, ok } = await this.runStepWithPolicy(
          step,
          iteration,
          policy,
          runner,
          variables,
        );
        history.push(entry);

        if (!ok) {
          const recovered = this.applyRecovery(entry, recovery);
          if (recovered.action === 'abort') {
            status = 'failed';
            break outer;
          }
          // 'continue' or 'compensate' — this step did not succeed but the run
          // proceeds. A compensation step, when named, runs immediately.
          if (recovered.action === 'compensate' && recovery.compensateWith) {
            const comp = ordered.find((s) => s.id === recovery.compensateWith);
            if (comp) {
              const compResult = await this.runStepWithPolicy(
                comp,
                1,
                comp.policy ?? DEFAULT_STEP_POLICY,
                runner,
                variables,
              );
              history.push(compResult.entry);
            }
          }
          stepFailed = true;
          break;
        }
      }

      if (stepFailed) {
        skipped.add(step.id);
      } else {
        succeeded.add(step.id);
      }
    }

    const endedAt = this.clock().toISOString();
    this.persistRun(workflow, status, history, startedAt, endedAt);
    return { workflowId: workflow.workflowId, version: workflow.version, status, history };
  }

  /**
   * Run a single step honoring its retry and timeout policy. Returns the
   * history entry (with the attempts consumed and the final outcome) and whether
   * the step ultimately succeeded. A single attempt whose reported duration
   * exceeds the timeout counts as a failed (timed-out) attempt.
   */
  private async runStepWithPolicy(
    step: WorkflowStep,
    iteration: number,
    policy: WorkflowStepPolicy,
    runner: WorkflowStepRunner,
    variables: Record<string, unknown>,
  ): Promise<{ entry: WorkflowStepHistoryEntry; ok: boolean }> {
    const startedAt = this.clock().toISOString();
    const maxAttempts = policy.maxRetries + 1;
    let attempt = 0;
    let lastDetail: string | undefined;
    let ok = false;

    while (attempt < maxAttempts) {
      attempt += 1;
      const result = await runner.run({ step, iteration, attempt, variables });
      if (result.durationMs > policy.timeoutMs) {
        lastDetail = `attempt ${attempt} exceeded timeout of ${policy.timeoutMs}ms`;
        continue; // timed-out attempt is a failure; retry if budget remains
      }
      if (result.ok) {
        ok = true;
        lastDetail = result.detail;
        break;
      }
      lastDetail = result.detail ?? `attempt ${attempt} failed`;
    }

    const endedAt = this.clock().toISOString();
    const outcome: WorkflowStepOutcome = ok ? 'succeeded' : 'failed';
    const entry: WorkflowStepHistoryEntry = {
      stepId: step.id,
      iteration,
      startedAt,
      endedAt,
      outcome,
      attempts: attempt,
      ...(lastDetail !== undefined ? { detail: lastDetail } : {}),
    };
    return { entry, ok };
  }

  /**
   * Annotate a failed step's history entry with the recovery action taken and
   * report which action the engine should apply (Requirement 15.7).
   */
  private applyRecovery(
    entry: WorkflowStepHistoryEntry,
    recovery: WorkflowErrorRecovery,
  ): { action: WorkflowErrorRecovery['kind'] } {
    entry.recoveryAction = recovery.kind;
    return { action: recovery.kind };
  }

  private skipEntry(
    step: WorkflowStep,
    detail: string,
  ): WorkflowStepHistoryEntry {
    const now = this.clock().toISOString();
    return {
      stepId: step.id,
      iteration: 1,
      startedAt: now,
      endedAt: now,
      outcome: 'skipped',
      attempts: 0,
      detail,
    };
  }

  private truthy(value: unknown): boolean {
    return value === true || value === 'true' || (typeof value === 'number' && value !== 0);
  }

  private assertRecoveryTargetsExist(
    steps: readonly WorkflowStep[],
    workflowRecovery: WorkflowErrorRecovery,
  ): void {
    const ids = new Set(steps.map((s) => s.id));
    const check = (rec: WorkflowErrorRecovery | undefined, where: string) => {
      if (
        rec?.kind === 'compensate' &&
        (rec.compensateWith === undefined || !ids.has(rec.compensateWith))
      ) {
        throw new WorkflowValidationError(
          where,
          `error-recovery compensate step "${rec.compensateWith ?? ''}" is not a step in the workflow`,
        );
      }
    };
    check(workflowRecovery, 'errorRecovery');
    for (const step of steps) {
      check(step.errorRecovery, `steps.${step.id}.errorRecovery`);
    }
  }

  private persistRun(
    workflow: DagWorkflow,
    status: WorkflowRunStatus,
    history: readonly WorkflowStepHistoryEntry[],
    startedAt: string,
    endedAt: string,
  ): void {
    this.store.transaction((tx) => {
      const runId = randomUUID();
      tx.db
        .prepare(
          `INSERT INTO workflow_runs (id, workflow_id, version, status, started_at, ended_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(runId, workflow.workflowId, workflow.version, status, startedAt, endedAt);

      const insert = tx.db.prepare(
        `INSERT INTO workflow_step_history
           (id, run_id, step_id, iteration, ordinal, started_at, ended_at,
            outcome, attempts, recovery_action, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      history.forEach((entry, ordinal) => {
        insert.run(
          randomUUID(),
          runId,
          entry.stepId,
          entry.iteration,
          ordinal,
          entry.startedAt,
          entry.endedAt,
          entry.outcome,
          entry.attempts,
          entry.recoveryAction ?? null,
          entry.detail ?? null,
        );
      });
    });
  }
}

export { MAX_WORKFLOW_STEPS };
