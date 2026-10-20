// The planner seam the orchestrator decomposes an objective through on the
// PLANNING transition (Requirement 5.4).
//
// Planning has two separable concerns:
//
//   1. DECOMPOSITION — turning a natural-language objective into one or more
//      steps, each with a description, the capability it needs, the permissions
//      it will exercise, and the ids of the steps it depends on. The real,
//      LLM-driven decomposer lands later; until then the orchestrator must
//      still have a seam to plan through so the lifecycle (PLANNING → routed,
//      persisted DAG) is wired end to end and testable. This module is that
//      seam: a narrow `Planner` interface the orchestrator depends on, plus a
//      deterministic placeholder implementation that produces a single step.
//
//   2. The DAG itself — the topological ordering of the decomposed steps and
//      the rejection of a cyclic dependency graph (Requirement 5.8). That is a
//      pure graph operation (`topologicalSort`) with no knowledge of adapters
//      or persistence, kept here next to the shapes it operates on.
//
// Keeping decomposition behind the `Planner` interface means the real planner
// can drop in without the orchestrator changing: the orchestrator only ever
// sees `decompose` returning a `PlanDecomposition`, then routes and persists it.

import type { PermissionRequirement } from '@shared/domain';

/**
 * One planned step produced by a {@link Planner}, before routing assigns an
 * adapter. `id` is planner-local and used only to express dependencies within
 * the decomposition; the orchestrator mints the durable step id on persistence.
 */
export interface PlannedStep {
  /** Planner-local id, unique within the decomposition; names dependency edges. */
  readonly id: string;
  /** Human-readable description of what the step does. */
  readonly description: string;
  /** The capability id the step needs an adapter (or fallback) to provide. */
  readonly requiredCapability: string;
  /** Adapter input supplied by trusted application planning. */
  readonly input?: unknown;
  /**
   * Permissions the step will exercise. Optional; an empty/omitted list means
   * the step needs no special permission. Routing uses these to decide adapter
   * eligibility under the active profile.
   */
  readonly requiredPermissions?: readonly PermissionRequirement[];
  /**
   * Planner-local ids of the steps this step depends on. Every id must refer to
   * another step in the same decomposition; a cycle among these edges is
   * rejected during planning (Requirement 5.8).
   */
  readonly dependsOn?: readonly string[];
}

/** The result of decomposing an objective: the steps forming the intra-task DAG. */
export interface PlanDecomposition {
  readonly steps: readonly PlannedStep[];
}

/** A request to decompose a task's objective into an executable plan. */
export interface PlanRequest {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly objective: string;
  /** Context reference ids resolved during CONTEXT_LOADING, for the real planner. */
  readonly contextRefs: readonly string[];
  /** Acceptance criteria the plan should ultimately satisfy. */
  readonly acceptanceCriteria: readonly string[];
}

/**
 * The seam the orchestrator decomposes a plan through. Implementations must be
 * deterministic for a given request so planning (and the recovery that replans)
 * stays reproducible, and must resolve (never reject) for a well-formed request
 * so a planning failure is modeled by the orchestrator as a transition rather
 * than an unhandled throw.
 */
export interface Planner {
  decompose(request: PlanRequest): Promise<PlanDecomposition>;
}

/** The default capability the placeholder planner's single step requires. */
export const PLACEHOLDER_PLAN_CAPABILITY = 'objective.fulfill';

/**
 * The M1–M3 placeholder planner. It decomposes every objective into a single
 * dependency-free step requiring a generic `objective.fulfill` capability. This
 * is the correct behavior before the real LLM-driven planner exists: the task
 * gets a trivially-acyclic one-step DAG that routing can resolve against
 * whatever adapter declares the capability. It is deterministic (same request →
 * same decomposition) so it never destabilizes the lifecycle tests, and it is
 * the default the orchestrator uses when a real planner is not injected.
 */
export class PlaceholderPlanner implements Planner {
  decompose(request: PlanRequest): Promise<PlanDecomposition> {
    return Promise.resolve({
      steps: [
        {
          id: 'step-1',
          description: `Fulfill objective: ${request.objective}`,
          requiredCapability: PLACEHOLDER_PLAN_CAPABILITY,
        },
      ],
    });
  }
}

/** Raised when a decomposition's dependency graph contains a cycle. */
export class PlanCycleError extends Error {
  /** The step ids participating in the detected cycle, in traversal order. */
  readonly cycle: readonly string[];
  constructor(cycle: readonly string[]) {
    super(
      `Plan dependency graph is cyclic: ${cycle.join(' -> ')}`,
    );
    this.name = 'PlanCycleError';
    this.cycle = cycle;
  }
}

/** Raised when a step depends on an id that is not present in the decomposition. */
export class PlanDependencyError extends Error {
  constructor(
    readonly stepId: string,
    readonly missingDependency: string,
  ) {
    super(
      `Step "${stepId}" depends on unknown step "${missingDependency}"`,
    );
    this.name = 'PlanDependencyError';
  }
}

/** Raised when a decomposition produces no steps at all (Requirement 5.4). */
export class EmptyPlanError extends Error {
  constructor() {
    super('Plan must decompose the objective into at least one step');
    this.name = 'EmptyPlanError';
  }
}

/** Raised when two steps in a decomposition share the same planner-local id. */
export class DuplicateStepIdError extends Error {
  constructor(readonly stepId: string) {
    super(`Duplicate step id in plan decomposition: "${stepId}"`);
    this.name = 'DuplicateStepIdError';
  }
}

/**
 * Topologically order the steps of a decomposition so every step appears after
 * all of its dependencies (Requirement 5.4). The ordering is deterministic:
 * ties are broken by the step's position in the input, so identical inputs
 * always yield an identical order.
 *
 * Validates the graph before ordering and throws rather than returning a
 * partial order:
 *   - {@link EmptyPlanError} when there are no steps,
 *   - {@link DuplicateStepIdError} when two steps share an id,
 *   - {@link PlanDependencyError} when a dependency references an unknown step,
 *   - {@link PlanCycleError} when the dependency edges form a cycle.
 *
 * The cycle error carries the offending step ids so the caller (and the
 * orchestrator's error) can name the cyclic dependency (Requirement 5.8). This
 * is a pure function: no I/O, no clock, deterministic in its argument.
 */
export function topologicalSort(
  decomposition: PlanDecomposition,
): PlannedStep[] {
  const steps = decomposition.steps;
  if (steps.length === 0) {
    throw new EmptyPlanError();
  }

  // Index by id, rejecting duplicates so dependency edges are unambiguous.
  const byId = new Map<string, PlannedStep>();
  for (const step of steps) {
    if (byId.has(step.id)) {
      throw new DuplicateStepIdError(step.id);
    }
    byId.set(step.id, step);
  }

  // Validate every dependency refers to a real step before traversing.
  for (const step of steps) {
    for (const dep of step.dependsOn ?? []) {
      if (!byId.has(dep)) {
        throw new PlanDependencyError(step.id, dep);
      }
    }
  }

  // Depth-first topological sort with explicit cycle detection. `state` is
  // 0 = unvisited, 1 = on the current DFS path (gray), 2 = finished (black).
  // Reaching a gray node means we closed a cycle; we reconstruct it from the
  // active path for a precise error. Iterating `steps` in input order (and
  // dependencies in their declared order) makes the result deterministic.
  const UNVISITED = 0;
  const ON_PATH = 1;
  const DONE = 2;
  const state = new Map<string, number>();
  const order: PlannedStep[] = [];
  const path: string[] = [];

  const visit = (id: string): void => {
    const current = state.get(id) ?? UNVISITED;
    if (current === DONE) {
      return;
    }
    if (current === ON_PATH) {
      // Closed a cycle: slice the active path from the first occurrence of
      // this id, then append it again to show the closing edge.
      const start = path.indexOf(id);
      const cycle = [...path.slice(start), id];
      throw new PlanCycleError(cycle);
    }

    state.set(id, ON_PATH);
    path.push(id);
    // Non-null: every id here is a key of `byId` (validated above).
    const step = byId.get(id)!;
    for (const dep of step.dependsOn ?? []) {
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
