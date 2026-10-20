// The context provider seam the orchestrator loads context through on the
// CONTEXT_LOADING transition (Requirement 5.3).
//
// The real universal Context Engine — the five-scope, source-linked model with
// veracity, confidence, and provenance — lands in milestone M4 (task 16). Until
// then the orchestrator must still have a seam to load context through so the
// task lifecycle (CREATED → CONTEXT_LOADING → PLANNING) is wired end to end and
// testable. This module is that seam: a narrow interface the orchestrator
// depends on, plus a deterministic placeholder implementation that loads no
// external context and returns an empty bundle.
//
// Keeping the real engine behind this interface means task 16 can drop in a
// richer provider without the orchestrator changing: the orchestrator only ever
// sees `retrieveContext` returning a `ContextBundle` of context reference ids.

/** A request to load context for a task about to begin execution. */
export interface ContextRequest {
  /** The task the context is being loaded for. */
  readonly taskId: string;
  /** The workspace the task belongs to, scoping project/workspace context. */
  readonly workspaceId: string;
  /** The natural-language objective, used by the real engine to retrieve context. */
  readonly objective: string;
}

/**
 * The context loaded for a task. `refs` are opaque, durable context reference
 * ids persisted on `Task.contextRefs`; they point at whatever the provider
 * resolved (memories, documents, prior task state). The placeholder returns an
 * empty list; the M4 engine returns real references.
 */
export interface ContextBundle {
  readonly refs: readonly string[];
}

/**
 * The seam the orchestrator loads context through. Implementations must be
 * free of side effects beyond reading their own context store, and must resolve
 * (never reject) for a well-formed request so a context failure is modeled as a
 * BLOCKED/missing-context transition rather than an unhandled error.
 */
export interface ContextProvider {
  retrieveContext(request: ContextRequest): Promise<ContextBundle>;
}

/**
 * The M1–M3 placeholder context provider. It performs no retrieval and returns
 * an empty bundle, which is the correct behavior before the Context Engine
 * exists: the task loads "no context" and proceeds to planning. It is
 * deterministic (same request → same empty bundle) so it never destabilizes the
 * lifecycle tests, and it is the default the orchestrator uses when a real
 * provider is not injected.
 */
export class PlaceholderContextProvider implements ContextProvider {
  retrieveContext(_request: ContextRequest): Promise<ContextBundle> {
    return Promise.resolve({ refs: [] });
  }
}
