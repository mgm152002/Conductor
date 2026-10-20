// Pure graph operations for the Workflow DAG engine (Requirement 15.2).
//
// A DAG_Workflow's steps-and-dependencies graph must be acyclic and at most
// MAX_WORKFLOW_STEPS steps. This module validates that graph and produces a
// deterministic dependency order, with no knowledge of persistence, adapters,
// or execution. It mirrors the intra-task planner's `topologicalSort`
// (src/main/orchestrator/planner.ts): depth-first ordering with explicit
// gray/black cycle detection, deterministic tie-breaking by input position,
// and precise errors naming the offending steps so the Workflow_Engine can
// report them (Requirement 15.2).

import { MAX_WORKFLOW_STEPS, type WorkflowStep } from '@shared/domain';

/** Raised when a workflow's dependency graph contains a cycle. */
export class WorkflowCycleError extends Error {
  /** The step ids participating in the detected cycle, in traversal order. */
  readonly cycle: readonly string[];
  constructor(cycle: readonly string[]) {
    super(`Workflow dependency graph is cyclic: ${cycle.join(' -> ')}`);
    this.name = 'WorkflowCycleError';
    this.cycle = cycle;
  }
}

/** Raised when a step depends on an id not present in the workflow. */
export class WorkflowDependencyError extends Error {
  constructor(
    readonly stepId: string,
    readonly missingDependency: string,
  ) {
    super(`Step "${stepId}" depends on unknown step "${missingDependency}"`);
    this.name = 'WorkflowDependencyError';
  }
}

/** Raised when a workflow has no steps at all. */
export class EmptyWorkflowError extends Error {
  constructor() {
    super('Workflow must contain at least one step');
    this.name = 'EmptyWorkflowError';
  }
}

/** Raised when two steps in a workflow share the same id. */
export class DuplicateWorkflowStepIdError extends Error {
  constructor(readonly stepId: string) {
    super(`Duplicate step id in workflow: "${stepId}"`);
    this.name = 'DuplicateWorkflowStepIdError';
  }
}

/** Raised when a workflow exceeds {@link MAX_WORKFLOW_STEPS} steps. */
export class WorkflowSizeError extends Error {
  constructor(
    readonly stepCount: number,
    readonly limit: number,
  ) {
    super(
      `Workflow has ${stepCount} steps, exceeding the limit of ${limit}`,
    );
    this.name = 'WorkflowSizeError';
  }
}

/**
 * Validate a workflow's steps-and-dependencies graph and return the steps in a
 * deterministic dependency order (every step after all of its dependencies).
 *
 * Throws rather than returning a partial result:
 *   - {@link EmptyWorkflowError} when there are no steps,
 *   - {@link WorkflowSizeError} when the step count exceeds the 500-step limit,
 *   - {@link DuplicateWorkflowStepIdError} when two steps share an id,
 *   - {@link WorkflowDependencyError} when a dependency names an unknown step,
 *   - {@link WorkflowCycleError} when the dependency edges form a cycle.
 *
 * The 500-step bound is checked before traversal so an oversized graph is
 * rejected cheaply (Requirement 15.2). This is a pure function: no I/O, no
 * clock, deterministic in its argument.
 */
export function validateWorkflowGraph(
  steps: readonly WorkflowStep[],
): WorkflowStep[] {
  if (steps.length === 0) {
    throw new EmptyWorkflowError();
  }
  if (steps.length > MAX_WORKFLOW_STEPS) {
    throw new WorkflowSizeError(steps.length, MAX_WORKFLOW_STEPS);
  }

  // Index by id, rejecting duplicates so dependency edges are unambiguous.
  const byId = new Map<string, WorkflowStep>();
  for (const step of steps) {
    if (byId.has(step.id)) {
      throw new DuplicateWorkflowStepIdError(step.id);
    }
    byId.set(step.id, step);
  }

  // Validate every dependency refers to a real step before traversing.
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!byId.has(dep)) {
        throw new WorkflowDependencyError(step.id, dep);
      }
    }
  }

  // Depth-first topological sort with explicit cycle detection:
  // 0 = unvisited, 1 = on the current DFS path (gray), 2 = finished (black).
  // Reaching a gray node means we closed a cycle; reconstruct it from the
  // active path. Iterating in input order makes the order deterministic.
  const UNVISITED = 0;
  const ON_PATH = 1;
  const DONE = 2;
  const state = new Map<string, number>();
  const order: WorkflowStep[] = [];
  const path: string[] = [];

  const visit = (id: string): void => {
    const current = state.get(id) ?? UNVISITED;
    if (current === DONE) {
      return;
    }
    if (current === ON_PATH) {
      const start = path.indexOf(id);
      const cycle = [...path.slice(start), id];
      throw new WorkflowCycleError(cycle);
    }

    state.set(id, ON_PATH);
    path.push(id);
    // Non-null: every id here is a key of `byId` (validated above).
    const step = byId.get(id)!;
    for (const dep of step.dependsOn) {
      visit(dep);
    }
    path.pop();
    state.set(id, DONE);
    order.push(step);
  };

  for (const step of steps) {
    visit(step.id);
  }

  return order;
}
