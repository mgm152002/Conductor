// The MCP & Integration Registry contracts and the data-model shapes that
// surround them (Requirement 17). An MCP server is a discoverable external
// integration the orchestrator can register, health-check, and invoke, plus the
// seam through which Conductor can expose its own approved capabilities to
// external agents. Everything that actually touches an external MCP server —
// discovery, health probing, invocation — goes through the McpTransport seam so
// the registry's control logic (validation, trust gating, timeouts,
// cancellation, access control, audit) is unit-testable without any real
// server.
//
// These are the durable contracts shared across main, preload, and renderer.
// The runtime Zod validation for IPC payloads referencing these lives in
// `ipc-contract.ts` (added when the MCP IPC surface lands); these are the
// TypeScript shapes the schemas produce and the UI consumes.
//
// SAFETY INVARIANT: an MCP server starts `untrusted` and `disabled`. It can only
// become enabled through an explicit approval by an authorized approver
// (Requirement 17.9). While it is untrusted and unapproved it stays disabled and
// every invocation targeting it is rejected (Requirement 17.10). Conductor
// exposes only capabilities that have been explicitly approved for external
// exposure, and never exposes unapproved ones (Requirement 17.8).

// ---------------------------------------------------------------------------
// Timing bounds fixed by Requirement 17
// ---------------------------------------------------------------------------

/** Discovery must return within this many ms (Requirement 17.1). */
export const MCP_DISCOVERY_TIMEOUT_MS = 10_000;

/** Health checks run at an interval not exceeding this many ms (Requirement 17.3). */
export const MCP_MAX_HEALTH_CHECK_INTERVAL_MS = 60_000;

/** An integration request's timeout may not exceed this many ms (Requirement 17.4). */
export const MCP_MAX_REQUEST_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Trust, registration, enablement, and health state
// ---------------------------------------------------------------------------

/**
 * Trust status of an MCP server. A server is `untrusted` until an authorized
 * approver explicitly approves it, at which point it becomes `trusted`
 * (Requirement 17.9). Trust is what gates enablement and invocation.
 */
export type McpTrustStatus = 'untrusted' | 'trusted';

/**
 * Whether the server has been registered into the local registry. A
 * `discovered` server is visible from discovery but not yet registered;
 * `registered` means it has a durable record (Requirement 17.1).
 */
export type McpRegistrationState = 'discovered' | 'registered';

/**
 * Whether a registered server is enabled for invocation. An untrusted server is
 * always `disabled`; only a trusted (approved) server may be `enabled`
 * (Requirement 17.9 / 17.10).
 */
export type McpEnablementState = 'disabled' | 'enabled';

/**
 * Health of a registered server, recorded by periodic health checks
 * (Requirement 17.3). `unknown` before the first check; `healthy`/`unhealthy`
 * after.
 */
export type McpHealthState = 'unknown' | 'healthy' | 'unhealthy';

/**
 * One capability an MCP server advertises. Kept deliberately minimal: an id and
 * a human title; the detailed I/O schema lives with the server and is validated
 * at invocation time by the server itself.
 */
export interface McpServerCapability {
  id: string;
  title: string;
}

/**
 * A single entry returned from discovery (Requirement 17.1): the server's
 * identifier, its trust status, and its registration state. Discovery never
 * enables anything; it only reports what exists and its control state.
 */
export interface McpDiscoveryEntry {
  id: string;
  name: string;
  /** Transport endpoint label (URL, command, socket) — never a secret. */
  endpoint: string;
  trustStatus: McpTrustStatus;
  registrationState: McpRegistrationState;
}

/** A durable, registered MCP server record. */
export interface McpServer {
  id: string;
  name: string;
  /** Transport endpoint label (URL, command, socket) — never a secret. */
  endpoint: string;
  trustStatus: McpTrustStatus;
  registrationState: 'registered';
  enablement: McpEnablementState;
  health: McpHealthState;
  capabilities: McpServerCapability[];
  /** When an authorized approver approved the server, if ever (Req 17.9). */
  approvedBy?: string;
  approvedAt?: string;
  lastHealthCheckAt?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Registration input
// ---------------------------------------------------------------------------

/**
 * The input a caller submits to register an integration (Requirement 17.2).
 * `id`, `name`, and `endpoint` are required; capabilities default to empty. The
 * registry validates every field and preserves prior registry state on any
 * validation failure.
 */
export interface McpRegistrationInput {
  id: string;
  name: string;
  endpoint: string;
  capabilities?: McpServerCapability[];
}

// ---------------------------------------------------------------------------
// External capability exposure (Requirement 17.8)
// ---------------------------------------------------------------------------

/**
 * A Conductor capability approved for external exposure through Conductor's own
 * MCP server. Only approved capabilities are ever exposed; an unapproved
 * capability is never surfaced to external agents (Requirement 17.8).
 */
export interface ExposedCapability {
  capabilityId: string;
  title: string;
  approvedAt: string;
}

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

export interface McpInvocationRequest {
  serverId: string;
  capabilityId: string;
  /** JSON-serializable arguments; the server validates its own I/O schema. */
  args: unknown;
  /**
   * The actor invoking the integration. Access control is evaluated against
   * this caller (Requirement 17.6).
   */
  caller: string;
  /**
   * Per-request timeout in ms. Clamped to at most MCP_MAX_REQUEST_TIMEOUT_MS
   * (Requirement 17.4); omitted means the max.
   */
  timeoutMs?: number;
  /** Optional signal to cancel an in-flight invocation (Requirement 17.5). */
  signal?: AbortSignal;
}

/** Why an invocation failed, distinguishing the control-plane failure modes. */
export type McpInvocationErrorReason =
  | 'not_found' // no such registered server
  | 'not_approved' // server is untrusted/disabled (Requirement 17.10)
  | 'access_denied' // caller lacks the required access (Requirement 17.6)
  | 'timeout' // request exceeded its timeout (Requirement 17.4)
  | 'cancelled' // request was cancelled (Requirement 17.5)
  | 'unhealthy' // the transport reported the call failed
  | 'unknown_capability'; // server does not advertise the capability

export type McpInvocationResult =
  | { readonly ok: true; readonly output: unknown }
  | { readonly ok: false; readonly reason: McpInvocationErrorReason; readonly message: string };

// ---------------------------------------------------------------------------
// Transport seam — the only thing that touches a real external MCP server
// ---------------------------------------------------------------------------

/** The outcome of a transport-level health probe. */
export interface McpHealthProbeResult {
  healthy: boolean;
  detail?: string;
}

/**
 * The seam through which the registry talks to external MCP servers. In
 * production an implementation speaks the real Model Context Protocol; in tests
 * a fake is injected so discovery, health checks, timeouts, and cancellation
 * can be driven deterministically without any real server. The registry owns
 * ALL control logic (validation, trust gating, access control, timeout,
 * cancellation accounting, audit); the transport only performs the raw I/O.
 */
export interface McpTransport {
  /**
   * Discover the MCP servers reachable in the environment. The registry applies
   * the discovery timeout around this call (Requirement 17.1).
   */
  discover(): Promise<McpDiscoveryEntry[]>;

  /**
   * Probe a server's liveness/health. The registry calls this on its health
   * interval and records the result (Requirement 17.3).
   */
  probeHealth(server: McpServer): Promise<McpHealthProbeResult>;

  /**
   * Invoke a capability on a server and resolve with its raw output. The
   * registry wraps this in timeout + cancellation; a well-behaved transport
   * also honors `signal`. Rejecting signals a transport/server failure.
   */
  invoke(
    server: McpServer,
    capabilityId: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<unknown>;
}
