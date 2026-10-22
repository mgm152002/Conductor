import type { Store } from '../db/types';
import type { AuditLog } from '../domain/audit-log';
import {
  MCP_DISCOVERY_TIMEOUT_MS,
  MCP_MAX_REQUEST_TIMEOUT_MS,
  type ExposedCapability,
  type McpDiscoveryEntry,
  type McpInvocationErrorReason,
  type McpInvocationRequest,
  type McpInvocationResult,
  type McpRegistrationInput,
  type McpServer,
  type McpServerCapability,
  type McpTransport,
} from '@shared/mcp';

// The MCP & Integration Registry (Requirement 17). It owns ALL control-plane
// logic for external integrations — discovery, validated registration, periodic
// health checks, request timeouts with cancellation, access control, trust
// gating, external capability exposure, and a lifecycle audit event for every
// operation. The only thing that ever touches a real external MCP server is the
// injected `McpTransport` seam, so every control path here is unit-testable
// without any real server (discovery, timeouts, cancellation, and health are
// all driven by a fake transport + injectable clock/timer).
//
// SAFETY INVARIANT (Req 17.9 / 17.10): a server is admitted as `untrusted` and
// `disabled`. It can only be enabled after an authorized approver approves it,
// which flips it to `trusted`. While it is untrusted/unapproved it stays
// disabled and every invocation targeting it is rejected with `not_approved`.

/** Injectable timer seam so request timeouts run without real delay in tests. */
export interface McpTimerClock {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The real timer clock backed by the host timers. */
export const systemMcpTimerClock: McpTimerClock = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/**
 * The access-control seam (Requirement 17.6). Given the caller and the target
 * server/capability, returns whether the caller may invoke it. The default
 * policy denies by default: a caller must be explicitly granted. The host wires
 * in the real policy (bound to the Permission_Service); tests inject a
 * deterministic predicate.
 */
export type McpAccessControl = (ctx: {
  caller: string;
  server: McpServer;
  capabilityId: string;
}) => boolean;

/** Deny-by-default access control: no caller may invoke anything. */
export const denyAllAccessControl: McpAccessControl = () => false;

/** Raised when a registration input fails validation (Requirement 17.2). */
export class McpRegistrationError extends Error {
  constructor(
    readonly field: 'id' | 'name' | 'endpoint' | 'capabilities',
    message: string,
  ) {
    super(message);
    this.name = 'McpRegistrationError';
  }
}

/** Raised when a server id is already registered. */
export class McpDuplicateError extends Error {
  constructor(readonly serverId: string) {
    super(`MCP server ${serverId} is already registered`);
    this.name = 'McpDuplicateError';
  }
}

/** Raised when resolving a server id that is not registered. */
export class McpNotFoundError extends Error {
  constructor(readonly serverId: string) {
    super(`MCP server ${serverId} is not registered`);
    this.name = 'McpNotFoundError';
  }
}

/**
 * Raised when an enable is attempted on an untrusted (unapproved) server
 * (Requirement 17.9). The caller must obtain explicit approval first.
 */
export class McpApprovalRequiredError extends Error {
  constructor(readonly serverId: string) {
    super(
      `MCP server ${serverId} is untrusted; explicit approval is required before it can be enabled`,
    );
    this.name = 'McpApprovalRequiredError';
  }
}

interface McpServerRow {
  id: string;
  name: string;
  endpoint: string;
  trust_status: McpServer['trustStatus'];
  registration_state: 'registered';
  enablement: McpServer['enablement'];
  health: McpServer['health'];
  capabilities: string;
  approved_by: string | null;
  approved_at: string | null;
  last_health_check_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToServer(row: McpServerRow): McpServer {
  return {
    id: row.id,
    name: row.name,
    endpoint: row.endpoint,
    trustStatus: row.trust_status,
    registrationState: 'registered',
    enablement: row.enablement,
    health: row.health,
    capabilities: JSON.parse(row.capabilities) as McpServerCapability[],
    ...(row.approved_by !== null ? { approvedBy: row.approved_by } : {}),
    ...(row.approved_at !== null ? { approvedAt: row.approved_at } : {}),
    ...(row.last_health_check_at !== null
      ? { lastHealthCheckAt: row.last_health_check_at }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface ExposedRow {
  capability_id: string;
  title: string;
  approved_at: string;
}

export interface McpRegistryOptions {
  /** The seam that touches real external servers. Injected for tests. */
  transport: McpTransport;
  accessControl?: McpAccessControl;
  /** Timestamp clock (ms since epoch). */
  now?: () => number;
  /** Timer seam for request-timeout scheduling. */
  timer?: McpTimerClock;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Raised internally to carry a timeout/cancellation out of the race. */
class RequestAbortError extends Error {
  constructor(readonly reason: 'timeout' | 'cancelled') {
    super(reason);
    this.name = 'RequestAbortError';
  }
}

export class McpRegistry {
  private readonly transport: McpTransport;
  private readonly accessControl: McpAccessControl;
  private readonly now: () => number;
  private readonly timer: McpTimerClock;

  constructor(
    private readonly store: Store,
    private readonly audit: AuditLog,
    options: McpRegistryOptions,
  ) {
    this.transport = options.transport;
    this.accessControl = options.accessControl ?? denyAllAccessControl;
    this.now = options.now ?? (() => Date.now());
    this.timer = options.timer ?? systemMcpTimerClock;
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  // -------------------------------------------------------------------------
  // Discovery (Requirement 17.1)
  // -------------------------------------------------------------------------

  /**
   * Discover reachable MCP servers, returning each entry's id, trust status,
   * and registration state within the 10-second discovery bound
   * (Requirement 17.1). A transport that does not resolve within the bound is
   * aborted and surfaces a timeout error. Registration state is derived from
   * the local registry: a discovered id already present here reports
   * `registered`, otherwise `discovered`.
   */
  async discover(): Promise<McpDiscoveryEntry[]> {
    const discovered = await this.withTimeout(
      () => this.transport.discover(),
      MCP_DISCOVERY_TIMEOUT_MS,
      undefined,
    );

    const known = new Map(
      this.list().map((server) => [server.id, server] as const),
    );

    return discovered.map((entry) => {
      const local = known.get(entry.id);
      if (local !== undefined) {
        return {
          id: local.id,
          name: local.name,
          endpoint: local.endpoint,
          trustStatus: local.trustStatus,
          registrationState: 'registered' as const,
        };
      }
      return {
        id: entry.id,
        name: entry.name,
        endpoint: entry.endpoint,
        trustStatus: entry.trustStatus,
        registrationState: 'discovered' as const,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Registration (Requirement 17.2)
  // -------------------------------------------------------------------------

  /**
   * Register an integration after validating required fields. On any validation
   * failure nothing is persisted and the prior registry state is preserved; the
   * thrown error names the specific field. A newly registered server is always
   * untrusted + disabled + health unknown (it must be approved before it can be
   * enabled or invoked).
   */
  register(input: McpRegistrationInput): McpServer {
    this.validateRegistration(input);

    const id = input.id.trim();
    if (this.rawGet(id) !== undefined) {
      throw new McpDuplicateError(id);
    }

    const now = this.nowIso();
    const server: McpServer = {
      id,
      name: input.name.trim(),
      endpoint: input.endpoint.trim(),
      trustStatus: 'untrusted',
      registrationState: 'registered',
      enablement: 'disabled',
      health: 'unknown',
      capabilities: input.capabilities ?? [],
      createdAt: now,
      updatedAt: now,
    };

    this.store.transaction((tx) => {
      tx.db
        .prepare(
          `INSERT INTO mcp_servers
             (id, name, endpoint, trust_status, registration_state, enablement,
              health, capabilities, created_at, updated_at)
           VALUES (?, ?, ?, 'untrusted', 'registered', 'disabled', 'unknown', ?, ?, ?)`,
        )
        .run(
          server.id,
          server.name,
          server.endpoint,
          JSON.stringify(server.capabilities),
          server.createdAt,
          server.updatedAt,
        );
    });

    this.audit.append({
      actor: 'user',
      action: 'mcp.registered',
      target: server.id,
      redactedPayload: { name: server.name, endpoint: server.endpoint },
    });

    return server;
  }

  private validateRegistration(input: McpRegistrationInput): void {
    if (!isNonEmptyString(input.id)) {
      throw new McpRegistrationError('id', 'Server id is required');
    }
    if (!isNonEmptyString(input.name)) {
      throw new McpRegistrationError('name', 'Server name is required');
    }
    if (input.name.trim().length > 255) {
      throw new McpRegistrationError(
        'name',
        'Server name must be at most 255 characters',
      );
    }
    if (!isNonEmptyString(input.endpoint)) {
      throw new McpRegistrationError('endpoint', 'Server endpoint is required');
    }
    if (input.capabilities !== undefined) {
      if (!Array.isArray(input.capabilities)) {
        throw new McpRegistrationError(
          'capabilities',
          'capabilities must be an array',
        );
      }
      input.capabilities.forEach((capability, index) => {
        if (
          typeof capability !== 'object' ||
          capability === null ||
          !isNonEmptyString((capability as McpServerCapability).id) ||
          !isNonEmptyString((capability as McpServerCapability).title)
        ) {
          throw new McpRegistrationError(
            'capabilities',
            `capabilities[${index}] must have a non-empty id and title`,
          );
        }
      });
    }
  }

  // -------------------------------------------------------------------------
  // Trust & enablement (Requirement 17.9 / 17.10)
  // -------------------------------------------------------------------------

  /**
   * Approve an untrusted server. Only an authorized approver performs this
   * (the host gates who may call it); approval flips the server to `trusted`
   * and records the approver and timestamp. An already-trusted server is
   * returned unchanged.
   */
  approve(serverId: string, approver: string): McpServer {
    const server = this.getOrThrow(serverId);
    if (server.trustStatus === 'trusted') {
      return server;
    }
    const now = this.nowIso();
    this.store.db
      .prepare(
        `UPDATE mcp_servers
         SET trust_status = 'trusted', approved_by = ?, approved_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(approver, now, now, serverId);
    this.audit.append({
      actor: approver,
      action: 'mcp.approved',
      target: serverId,
    });
    return this.getOrThrow(serverId);
  }

  /**
   * Enable a server for invocation. An untrusted (unapproved) server cannot be
   * enabled: the enable action is blocked and an McpApprovalRequiredError is
   * thrown, with a denial audit event, leaving the server disabled
   * (Requirement 17.9). A trusted server becomes `enabled`.
   */
  enable(serverId: string): McpServer {
    const server = this.getOrThrow(serverId);
    if (server.trustStatus !== 'trusted') {
      this.audit.append({
        actor: 'user',
        action: 'mcp.enable_blocked',
        target: serverId,
        redactedPayload: { reason: 'untrusted_requires_approval' },
      });
      throw new McpApprovalRequiredError(serverId);
    }
    const now = this.nowIso();
    this.store.db
      .prepare(
        `UPDATE mcp_servers SET enablement = 'enabled', updated_at = ? WHERE id = ?`,
      )
      .run(now, serverId);
    this.audit.append({ actor: 'user', action: 'mcp.enabled', target: serverId });
    return this.getOrThrow(serverId);
  }

  /**
   * Replace the capabilities a server advertises (e.g. after listing its tools
   * once it was approved). Validated like registration input.
   */
  setCapabilities(serverId: string, capabilities: McpServerCapability[]): McpServer {
    const server = this.getOrThrow(serverId);
    this.validateRegistration({ id: server.id, name: server.name, endpoint: server.endpoint, capabilities });
    this.store.db
      .prepare(`UPDATE mcp_servers SET capabilities = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(capabilities), this.nowIso(), serverId);
    this.audit.append({ actor: 'orchestrator', action: 'mcp.capabilities_updated', target: serverId, redactedPayload: { count: capabilities.length } });
    return this.getOrThrow(serverId);
  }

  /** Remove a server from the registry entirely. */
  remove(serverId: string): void {
    this.getOrThrow(serverId);
    this.store.db.prepare(`DELETE FROM mcp_servers WHERE id = ?`).run(serverId);
    this.audit.append({ actor: 'user', action: 'mcp.removed', target: serverId });
  }

  /** Disable a server for invocation. Always allowed. */
  disable(serverId: string): McpServer {
    this.getOrThrow(serverId);
    const now = this.nowIso();
    this.store.db
      .prepare(
        `UPDATE mcp_servers SET enablement = 'disabled', updated_at = ? WHERE id = ?`,
      )
      .run(now, serverId);
    this.audit.append({ actor: 'user', action: 'mcp.disabled', target: serverId });
    return this.getOrThrow(serverId);
  }

  // -------------------------------------------------------------------------
  // Health checks (Requirement 17.3)
  // -------------------------------------------------------------------------

  /**
   * Run a single health check over every registered server and record each
   * server's health as healthy/unhealthy (unknown stays unknown only until the
   * first check). A scheduler calls this at an interval not exceeding 60
   * seconds (enforced by the caller via {@link MCP_MAX_HEALTH_CHECK_INTERVAL_MS}).
   * A probe that throws is recorded as unhealthy rather than propagating.
   */
  async runHealthChecks(): Promise<McpServer[]> {
    const servers = this.list();
    const results: McpServer[] = [];
    for (const server of servers) {
      results.push(await this.checkHealth(server.id));
    }
    return results;
  }

  /** Health-check a single server and persist the recorded state. */
  async checkHealth(serverId: string): Promise<McpServer> {
    const server = this.getOrThrow(serverId);
    let healthy: boolean;
    try {
      const probe = await this.transport.probeHealth(server);
      healthy = probe.healthy;
    } catch {
      healthy = false;
    }
    const now = this.nowIso();
    this.store.db
      .prepare(
        `UPDATE mcp_servers SET health = ?, last_health_check_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(healthy ? 'healthy' : 'unhealthy', now, now, serverId);
    return this.getOrThrow(serverId);
  }

  // -------------------------------------------------------------------------
  // Invocation (Requirement 17.4 / 17.5 / 17.6 / 17.10)
  // -------------------------------------------------------------------------

  /**
   * Invoke a capability on a registered server, enforcing — in order — the
   * trust/enablement gate (17.10), access control (17.6), and a bounded timeout
   * with cancellation (17.4 / 17.5). Every outcome (success, each denial, the
   * timeout, the cancellation) records a lifecycle audit event (17.7). Registry
   * state is never mutated by an invocation, so a timeout/cancellation leaves
   * the registry unchanged.
   */
  async invoke(request: McpInvocationRequest): Promise<McpInvocationResult> {
    const server = this.rawGet(request.serverId);
    if (server === undefined) {
      this.auditInvocation(request, 'not_found');
      return this.fail(
        'not_found',
        `MCP server ${request.serverId} is not registered`,
      );
    }

    // Trust/enablement gate FIRST: an untrusted or disabled server rejects
    // every invocation, regardless of the caller's access (Requirement 17.10).
    if (server.trustStatus !== 'trusted' || server.enablement !== 'enabled') {
      this.auditInvocation(request, 'not_approved');
      return this.fail(
        'not_approved',
        `MCP server ${server.id} is not approved; invocation rejected`,
      );
    }

    // Capability must be advertised by the server.
    const hasCapability = server.capabilities.some(
      (capability) => capability.id === request.capabilityId,
    );
    if (!hasCapability) {
      this.auditInvocation(request, 'unknown_capability');
      return this.fail(
        'unknown_capability',
        `MCP server ${server.id} does not advertise capability ${request.capabilityId}`,
      );
    }

    // Access control (Requirement 17.6).
    const allowed = this.accessControl({
      caller: request.caller,
      server,
      capabilityId: request.capabilityId,
    });
    if (!allowed) {
      this.auditInvocation(request, 'access_denied');
      return this.fail(
        'access_denied',
        `Caller ${request.caller} lacks access to ${server.id}/${request.capabilityId}`,
      );
    }

    // Bounded timeout (clamped to ≤30s) with cancellation (17.4 / 17.5).
    const timeoutMs = Math.min(
      request.timeoutMs ?? MCP_MAX_REQUEST_TIMEOUT_MS,
      MCP_MAX_REQUEST_TIMEOUT_MS,
    );
    const controller = new AbortController();

    // Propagate an external cancellation signal into our controller.
    const external = request.signal;
    if (external !== undefined) {
      if (external.aborted) {
        this.auditInvocation(request, 'cancelled');
        return this.fail('cancelled', 'Invocation was cancelled');
      }
      external.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      const output = await this.withTimeout(
        () => this.transport.invoke(
          server,
          request.capabilityId,
          request.args,
          controller.signal,
        ),
        timeoutMs,
        controller,
      );
      this.auditInvocation(request, undefined);
      return { ok: true, output };
    } catch (err) {
      if (err instanceof RequestAbortError) {
        this.auditInvocation(request, err.reason);
        return this.fail(
          err.reason,
          err.reason === 'timeout'
            ? `Invocation exceeded the ${timeoutMs}ms timeout`
            : 'Invocation was cancelled',
        );
      }
      const detail = err instanceof Error ? err.message : String(err);
      this.auditInvocation(request, 'unhealthy');
      return this.fail('unhealthy', `Invocation failed: ${detail}`);
    }
  }

  /**
   * Race a promise against a timeout. On timeout (or an aborted controller) the
   * returned promise rejects with a RequestAbortError and, when a controller is
   * supplied, aborts it so a cooperating transport terminates the in-flight
   * operation (Requirement 17.5). The underlying work is abandoned either way.
   */
  private withTimeout<T>(
    work: () => Promise<T>,
    ms: number,
    controller: AbortController | undefined,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const handle = this.timer.setTimeout(() => {
        if (settled) return;
        settled = true;
        controller?.abort();
        reject(new RequestAbortError('timeout'));
      }, ms);

      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        this.timer.clearTimeout(handle);
        reject(new RequestAbortError('cancelled'));
      };
      if (controller !== undefined) {
        controller.signal.addEventListener('abort', onAbort, { once: true });
      }

      work().then(
        (value) => {
          if (settled) return;
          settled = true;
          this.timer.clearTimeout(handle);
          resolve(value);
        },
        (err: unknown) => {
          if (settled) return;
          settled = true;
          this.timer.clearTimeout(handle);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  private fail(
    reason: McpInvocationErrorReason,
    message: string,
  ): McpInvocationResult {
    return { ok: false, reason, message };
  }

  private auditInvocation(
    request: McpInvocationRequest,
    denial: McpInvocationErrorReason | undefined,
  ): void {
    this.audit.append({
      actor: request.caller,
      action: denial === undefined ? 'mcp.invoked' : `mcp.invocation_${denial}`,
      target: request.serverId,
      redactedPayload: { capabilityId: request.capabilityId },
    });
  }

  // -------------------------------------------------------------------------
  // External capability exposure (Requirement 17.8)
  // -------------------------------------------------------------------------

  /**
   * Approve a Conductor capability for external exposure through Conductor's
   * own MCP server. Only approved capabilities are ever exposed.
   */
  exposeCapability(capability: {
    capabilityId: string;
    title: string;
  }): ExposedCapability {
    if (!isNonEmptyString(capability.capabilityId)) {
      throw new McpRegistrationError('id', 'capabilityId is required');
    }
    const now = this.nowIso();
    this.store.db
      .prepare(
        `INSERT INTO mcp_exposed_capabilities (capability_id, title, approved_at)
         VALUES (?, ?, ?)
         ON CONFLICT (capability_id)
         DO UPDATE SET title = excluded.title`,
      )
      .run(capability.capabilityId, capability.title, now);
    this.audit.append({
      actor: 'user',
      action: 'mcp.capability_exposed',
      target: capability.capabilityId,
    });
    return { capabilityId: capability.capabilityId, title: capability.title, approvedAt: now };
  }

  /** Revoke a capability's external exposure. */
  unexposeCapability(capabilityId: string): boolean {
    const result = this.store.db
      .prepare(`DELETE FROM mcp_exposed_capabilities WHERE capability_id = ?`)
      .run(capabilityId);
    if (result.changes > 0) {
      this.audit.append({
        actor: 'user',
        action: 'mcp.capability_unexposed',
        target: capabilityId,
      });
    }
    return result.changes > 0;
  }

  /**
   * The capabilities currently exposed to external agents (Requirement 17.8).
   * Only capabilities explicitly approved for exposure appear here; an
   * unapproved capability is never present and so is never exposed.
   */
  listExposedCapabilities(): ExposedCapability[] {
    const rows = this.store.db
      .prepare(
        `SELECT capability_id, title, approved_at FROM mcp_exposed_capabilities
         ORDER BY approved_at ASC, capability_id ASC`,
      )
      .all() as ExposedRow[];
    return rows.map((row) => ({
      capabilityId: row.capability_id,
      title: row.title,
      approvedAt: row.approved_at,
    }));
  }

  /** Whether a capability is approved for external exposure. */
  isCapabilityExposed(capabilityId: string): boolean {
    const row = this.store.db
      .prepare(
        `SELECT 1 FROM mcp_exposed_capabilities WHERE capability_id = ?`,
      )
      .get(capabilityId);
    return row !== undefined;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /** Resolve a registered server by id, or undefined when not registered. */
  get(serverId: string): McpServer | undefined {
    return this.rawGet(serverId);
  }

  getOrThrow(serverId: string): McpServer {
    const server = this.rawGet(serverId);
    if (server === undefined) {
      throw new McpNotFoundError(serverId);
    }
    return server;
  }

  /** All registered servers ordered by registration (creation ascending). */
  list(): McpServer[] {
    const rows = this.store.db
      .prepare(
        `SELECT * FROM mcp_servers ORDER BY created_at ASC, rowid ASC`,
      )
      .all() as McpServerRow[];
    return rows.map(rowToServer);
  }

  private rawGet(serverId: string): McpServer | undefined {
    const row = this.store.db
      .prepare(`SELECT * FROM mcp_servers WHERE id = ?`)
      .get(serverId) as McpServerRow | undefined;
    return row === undefined ? undefined : rowToServer(row);
  }
}
