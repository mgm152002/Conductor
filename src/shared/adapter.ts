// The AgentAdapter contract and the adapter/capability types that surround it.
//
// `AgentAdapter` is the single pluggability seam of the platform: local CLI
// agents, model providers, local tools, computer-interaction drivers, and the
// generalized remote-execution adapter all implement this one interface, so the
// orchestrator stays agent-agnostic. A remote-hosted harness is therefore
// indistinguishable from a local one to the orchestrator.
//
// The data-model shapes an adapter advertises (`AdapterRecord`,
// `CapabilityDescriptor`, `AdapterClass`, `PermissionRequirement`) are the
// durable contracts shared across main, preload, and renderer; they live in
// `domain.ts` as the single source of truth and are re-exported here so this
// module is the cohesive home for everything an adapter author needs.

import type {
  AdapterClass,
  AdapterRecord,
  AgentSession,
  CapabilityDescriptor,
  CostHint,
  LatencyHint,
  PermissionRequirement,
  PermissionRequirementKind,
} from './domain';

export type {
  AdapterClass,
  AdapterRecord,
  AgentSession,
  CapabilityDescriptor,
  CostHint,
  LatencyHint,
  PermissionRequirement,
  PermissionRequirementKind,
};

// ---- Adapter session plumbing ----

// Opaque handle returned by `start`/`resume` and threaded through
// `stream`/`await`/`cancel`. It identifies one in-flight adapter invocation
// (subprocess, HTTP exchange, remote harness session, ...). `externalRef`
// mirrors `AgentSession.externalRef` (pid / CLI session id / remote handle) so
// the Registry can probe liveness and the Resume Center can reconcile after a
// crash. Adapter-private details ride on `internal`, which the orchestrator
// treats as opaque.
export interface AdapterSessionHandle {
  readonly sessionId: string;
  readonly adapterId: string;
  readonly externalRef?: string;
  readonly resumable: boolean;
  readonly internal?: unknown;
}

// A single ordered event produced while an adapter runs. Every consumed event
// is checkpointed so a crash resumes mid-step without re-running completed
// steps. Payloads carry only redacted, placeholder-safe content (adapters never
// hold raw secrets).
export type AdapterStreamEventKind =
  | 'stdout'
  | 'stderr'
  | 'progress'
  | 'artifact'
  | 'heartbeat'
  | 'log';

export interface AdapterStreamEvent {
  readonly kind: AdapterStreamEventKind;
  readonly sequence: number; // monotonic within a session; drives checkpointing
  readonly data: unknown; // redacted / placeholder-safe content only
  readonly at: string; // ISO-8601 UTC
}

// Terminal outcome of an adapter invocation. An exit code of 0 is NOT by itself
// treated as success by the orchestrator; verification against acceptance
// criteria is the only completion signal.
export type AdapterResultStatus = 'succeeded' | 'failed' | 'cancelled';

export interface AdapterResult {
  readonly status: AdapterResultStatus;
  readonly exitCode?: number; // informational only; never a success signal
  readonly output?: unknown; // redacted / placeholder-safe content only
  readonly artifactIds?: string[]; // ids into Managed_Local_Storage
  readonly error?: string;
}

// ---- The adapter contract ----

// The single pluggability seam. Implementations normalize an external
// agent/tool's capabilities, I/O schemas, streaming, cancellation, and
// permission requirements.
//
// invariant: adapters receive only secret placeholders; every egress goes
// through the secrets proxy.
export interface AgentAdapter {
  // The capabilities, class, and non-secret config this adapter advertises to
  // the Registry and to capability-based routing.
  readonly record: AdapterRecord;

  // Reconcile a persisted session against reality (subprocess/CLI/remote
  // probe). A lost connection reports `false` so the Resume Center reconciles
  // rather than treating the session as succeeded.
  probeLiveness(session: AgentSession): Promise<boolean>;

  // Begin a new invocation. `input` is validated against the routed
  // capability's `inputSchema` by the caller.
  start(input: unknown): Promise<AdapterSessionHandle>;

  // Yield ordered events for a running invocation. Each consumed event is
  // checkpointed by the orchestrator.
  stream(handle: AdapterSessionHandle): AsyncIterable<AdapterStreamEvent>;

  // Resolve once the invocation reaches a terminal outcome.
  await(handle: AdapterSessionHandle): Promise<AdapterResult>;

  // Request cancellation of an in-flight invocation. The orchestrator
  // force-terminates sessions that do not acknowledge within its timeout.
  cancel(handle: AdapterSessionHandle): Promise<void>;

  // Optional: reattach to an interrupted session (only meaningful when the
  // session/capability is resumable). Absence means the adapter cannot resume
  // and the task must restart from its last checkpoint.
  resume?(session: AgentSession): Promise<AdapterSessionHandle>;
}
