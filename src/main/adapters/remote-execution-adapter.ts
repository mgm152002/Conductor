// A real generalized remote-execution AgentAdapter (Requirement 20, Property 6).
// It connects to a user-configured or provisioned cloud host over SSH (or an
// equivalent transport), bootstraps the host and installs the required agent
// harness when it is absent, and then drives that remote harness through the
// IDENTICAL AgentAdapter contract used for local agents — so a remote-hosted
// harness is indistinguishable from a local one to the orchestrator.
//
// invariant (Requirement 20.7 / 10.1): this adapter holds only
// `SecretPlaceholder` tokens — never a raw secret value. Placeholder tokens in
// the request are forwarded to the remote harness unchanged; the main-process
// secrets proxy is the single egress choke point that substitutes real values.
// `start` asserts its launch input carries no raw secret before any connection
// or egress happens.
//
// The transport (SSH/connection/provisioning/harness I/O) is behind an
// injectable `RemoteTransport` seam — the same pattern as `CliEnvironment` on
// the local adapter and `KeychainReader`/`CommandRunner` elsewhere — so unit
// tests exercise the full lifecycle without a real remote host.

import type {
  AdapterRecord,
  AdapterResult,
  AdapterSessionHandle,
  AdapterStreamEvent,
  AdapterStreamEventKind,
  AgentSession,
  AgentAdapter,
  CapabilityDescriptor,
} from '@shared/adapter';
import { assertNoRawSecret } from '../secrets/secrets-proxy';

/** The connection timeout ceiling mandated by Requirement 20.1 (≤ 60 seconds). */
export const MAX_CONNECTION_TIMEOUT_MS = 60_000;

/** Default connection timeout when the config does not pin one. */
const DEFAULT_CONNECTION_TIMEOUT_MS = 30_000;

/** How long (ms) a cancelled remote session is given to exit before a forced kill. */
const DEFAULT_CANCEL_GRACE_MS = 30_000;

/**
 * Raised when the transport cannot establish a connection to the remote host
 * within the configured timeout (Requirement 20.2). The adapter marks the
 * target unavailable before surfacing this.
 */
export class RemoteConnectionError extends Error {
  readonly reason: string | undefined;

  constructor(
    readonly host: string,
    readonly timeoutMs: number,
    reason?: string,
  ) {
    super(
      `Could not connect to remote host "${host}" within ${timeoutMs}ms` +
        (reason !== undefined ? `: ${reason}` : ''),
    );
    this.name = 'RemoteConnectionError';
    this.reason = reason;
  }
}

/**
 * Raised when provisioning/bootstrapping the host or installing the required
 * harness fails (Requirement 20.4). The adapter aborts use of the host and
 * does NOT route steps to it after this.
 */
export class RemoteProvisioningError extends Error {
  readonly reason: string | undefined;

  constructor(
    readonly host: string,
    readonly phase: 'provision' | 'install',
    reason?: string,
  ) {
    super(
      `Remote host "${host}" ${phase === 'provision' ? 'provisioning' : 'harness installation'} failed` +
        (reason !== undefined ? `: ${reason}` : ''),
    );
    this.name = 'RemoteProvisioningError';
    this.reason = reason;
  }
}

/** An opaque live connection to a remote host, owned by the transport. */
export interface RemoteConnection {
  /** The host this connection targets (for diagnostics / errors). */
  readonly host: string;
}

/** A handle to one harness invocation running on the remote host. */
export interface RemoteExecHandle {
  /** Transport-opaque reference to the remote process/session. */
  readonly remoteRef: string;
}

/** Ordered output produced by a remote harness invocation. */
export interface RemoteExecEvent {
  readonly kind: AdapterStreamEventKind;
  readonly data: unknown;
  /** Optional ISO-8601 timestamp; the adapter stamps one when absent. */
  readonly at?: string;
}

/** Terminal outcome of a remote harness invocation, transport-reported. */
export interface RemoteExecOutcome {
  /** Exit code of the remote process, when known (informational only). */
  readonly exitCode?: number;
  /** True when the invocation ended because it was cancelled/signalled. */
  readonly cancelled?: boolean;
}

/** The launch spec forwarded to the remote harness. Placeholder-safe. */
export interface RemoteExecSpec {
  /** Arguments for the remote harness. May contain placeholder tokens. */
  args?: string[];
  /** Text piped to the remote harness stdin. May contain placeholder tokens. */
  stdin?: string;
}

/**
 * The injectable transport seam. Every operation that touches the network or a
 * remote host goes through here, so unit tests substitute an in-memory fake and
 * never open a socket. A production implementation wraps an SSH client (or an
 * equivalent transport).
 */
export interface RemoteTransport {
  /**
   * Open a connection to `host`, rejecting if it cannot be established within
   * `timeoutMs`. Implementations MUST honor the timeout as a hard ceiling.
   *
   * @throws if the connection cannot be established in time or is refused.
   */
  connect(host: string, timeoutMs: number): Promise<RemoteConnection>;

  /**
   * Report whether the required agent harness is already present on the host.
   */
  isHarnessPresent(connection: RemoteConnection): Promise<boolean>;

  /**
   * Provision/bootstrap the host and install the required harness. Called only
   * when `isHarnessPresent` is false.
   *
   * @throws if provisioning or installation fails.
   */
  provisionAndInstall(connection: RemoteConnection): Promise<void>;

  /**
   * Launch the remote harness with the given (placeholder-safe) spec and return
   * a handle to the running invocation.
   */
  exec(
    connection: RemoteConnection,
    spec: RemoteExecSpec,
  ): Promise<RemoteExecHandle>;

  /** Yield ordered output for a running remote invocation. */
  stream(handle: RemoteExecHandle): AsyncIterable<RemoteExecEvent>;

  /** Resolve once the remote invocation reaches a terminal outcome. */
  wait(handle: RemoteExecHandle): Promise<RemoteExecOutcome>;

  /**
   * Request cancellation of a running remote invocation. `graceMs` is the
   * window before the transport should force-terminate.
   */
  cancel(handle: RemoteExecHandle, graceMs: number): Promise<void>;

  /**
   * Probe whether a persisted remote session is still live. A lost connection
   * MUST report `false` so the Resume Center reconciles the task rather than
   * trusting a stale "live" state (Requirement 20.6).
   */
  isSessionLive(host: string, remoteRef: string): Promise<boolean>;
}

export interface RemoteExecutionAdapterConfig {
  /** Adapter id used in the registry and sessions. */
  id: string;
  /** Human-readable adapter name. */
  name: string;
  /** Adapter semantic version. */
  version: string;
  /** The remote host to target, e.g. "ec2-user@203.0.113.7". */
  host: string;
  /** Capabilities this remote harness advertises to routing. */
  capabilities: CapabilityDescriptor[];
  /**
   * Connection timeout in ms. Clamped to {@link MAX_CONNECTION_TIMEOUT_MS}
   * (Requirement 20.1); defaults to 30s.
   */
  connectionTimeoutMs?: number;
  /** Grace period before force-terminating a cancelled remote session. */
  cancelGraceMs?: number;
}

interface LiveSession {
  readonly handle: AdapterSessionHandle;
  readonly connection: RemoteConnection;
  readonly execHandle: RemoteExecHandle;
}

export class RemoteExecutionAdapter implements AgentAdapter {
  readonly record: AdapterRecord;

  private readonly config: RemoteExecutionAdapterConfig;
  private readonly transport: RemoteTransport;
  private readonly connectionTimeoutMs: number;
  private readonly cancelGraceMs: number;
  private readonly sessions = new Map<string, LiveSession>();
  private sessionCounter = 0;
  // Set once provisioning/installation fails: the host is taken out of
  // rotation and no further steps are routed to it (Requirement 20.4).
  private unavailableReason: string | undefined;

  constructor(config: RemoteExecutionAdapterConfig, transport: RemoteTransport) {
    this.config = config;
    this.transport = transport;
    this.connectionTimeoutMs = Math.min(
      config.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
      MAX_CONNECTION_TIMEOUT_MS,
    );
    this.cancelGraceMs = config.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
    this.record = {
      id: config.id,
      class: 'remote_execution',
      name: config.name,
      version: config.version,
      capabilities: config.capabilities,
      // A freshly constructed adapter advertises availability; a connection or
      // provisioning failure flips this to false so routing stops selecting it.
      available: true,
      config: { host: config.host },
    };
  }

  /** Whether this remote target is currently routable. */
  get available(): boolean {
    return this.record.available;
  }

  /** Mark the target unavailable and record why, taking it out of routing. */
  private markUnavailable(reason: string): void {
    this.unavailableReason = reason;
    this.record.available = false;
  }

  async probeLiveness(session: AgentSession): Promise<boolean> {
    // Prefer an in-memory live session when present.
    const live = this.sessions.get(session.id);
    if (live !== undefined) {
      // A lost connection is reported as not-live rather than throwing, so the
      // Resume Center reconciles instead of treating the step as succeeded.
      try {
        return await this.transport.isSessionLive(
          live.connection.host,
          live.execHandle.remoteRef,
        );
      } catch {
        return false;
      }
    }
    // Otherwise reconcile against the persisted remote reference.
    const ref = session.externalRef;
    if (ref === undefined || ref.trim() === '') {
      return false;
    }
    try {
      return await this.transport.isSessionLive(this.config.host, ref);
    } catch {
      // A lost/failed probe is not-live (Requirement 20.6).
      return false;
    }
  }

  async start(input: unknown): Promise<AdapterSessionHandle> {
    // Enforce the confinement invariant before anything leaves this process:
    // the launch input may carry placeholder tokens but never a raw secret.
    assertNoRawSecret(input);

    // A host already taken out of rotation by a prior provisioning failure is
    // never connected to again (Requirement 20.4).
    if (!this.record.available) {
      throw new RemoteProvisioningError(
        this.config.host,
        'provision',
        this.unavailableReason ?? 'host previously marked unavailable',
      );
    }

    const spec = normalizeExecSpec(input);

    // Phase 1: connect within the timeout ceiling. A failure marks the target
    // unavailable and surfaces a connection error (Requirements 20.1, 20.2).
    let connection: RemoteConnection;
    try {
      connection = await this.transport.connect(
        this.config.host,
        this.connectionTimeoutMs,
      );
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      this.markUnavailable(`connection failed: ${cause}`);
      throw new RemoteConnectionError(
        this.config.host,
        this.connectionTimeoutMs,
        cause,
      );
    }

    // Phase 2: provision/bootstrap and install the harness when it is absent
    // (Requirement 20.3). A failure aborts use of the host, takes it out of
    // routing, and surfaces a provisioning error (Requirement 20.4).
    let harnessPresent: boolean;
    try {
      harnessPresent = await this.transport.isHarnessPresent(connection);
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      this.markUnavailable(`harness probe failed: ${cause}`);
      throw new RemoteProvisioningError(this.config.host, 'install', cause);
    }
    if (!harnessPresent) {
      try {
        await this.transport.provisionAndInstall(connection);
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        const phase =
          err instanceof RemoteProvisioningError ? err.phase : 'install';
        this.markUnavailable(`provisioning failed: ${cause}`);
        throw new RemoteProvisioningError(this.config.host, phase, cause);
      }
    }

    // Phase 3: launch the remote harness and record the session.
    const execHandle = await this.transport.exec(connection, spec);

    this.sessionCounter += 1;
    const sessionId = `${this.config.id}-session-${this.sessionCounter}`;
    const handle: AdapterSessionHandle = {
      sessionId,
      adapterId: this.config.id,
      externalRef: execHandle.remoteRef,
      resumable: false,
    };

    this.sessions.set(sessionId, { handle, connection, execHandle });
    return handle;
  }

  async *stream(
    handle: AdapterSessionHandle,
  ): AsyncIterable<AdapterStreamEvent> {
    const live = this.sessions.get(handle.sessionId);
    if (live === undefined) {
      return;
    }
    let sequence = 0;
    try {
      for await (const event of this.transport.stream(live.execHandle)) {
        sequence += 1;
        yield {
          kind: event.kind,
          sequence,
          data: event.data,
          at: event.at ?? new Date().toISOString(),
        };
      }
    } catch (err) {
      // A connection lost mid-stream surfaces as a log event and ends the
      // stream; liveness reconciliation (not the stream) is what reports the
      // session as not-live to the Resume Center.
      sequence += 1;
      yield {
        kind: 'log',
        sequence,
        data: {
          error:
            err instanceof Error ? err.message : 'remote stream interrupted',
        },
        at: new Date().toISOString(),
      };
    }
  }

  async await(handle: AdapterSessionHandle): Promise<AdapterResult> {
    const live = this.sessions.get(handle.sessionId);
    if (live === undefined) {
      return { status: 'failed', error: 'unknown session' };
    }

    let outcome: RemoteExecOutcome;
    try {
      outcome = await this.transport.wait(live.execHandle);
    } catch (err) {
      // A lost connection while awaiting is NOT a success. Report failed and
      // leave the session for the Resume Center to reconcile.
      const cause = err instanceof Error ? err.message : String(err);
      return { status: 'failed', error: `remote connection lost: ${cause}` };
    }

    this.sessions.delete(handle.sessionId);

    // A cancellation yields a cancelled result. An exit code is reported but —
    // per the contract — is NOT by itself a success signal; verification
    // against acceptance criteria is the orchestrator's only completion gate.
    if (outcome.cancelled === true) {
      return {
        status: 'cancelled',
        ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
      };
    }
    return {
      status: outcome.exitCode === 0 ? 'succeeded' : 'failed',
      ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
    };
  }

  async cancel(handle: AdapterSessionHandle): Promise<void> {
    const live = this.sessions.get(handle.sessionId);
    if (live === undefined) {
      return;
    }
    await this.transport.cancel(live.execHandle, this.cancelGraceMs);
  }
}

/** Normalize and validate the opaque `start` input into a typed launch spec. */
function normalizeExecSpec(input: unknown): RemoteExecSpec {
  if (input === null || typeof input !== 'object') {
    return {};
  }
  const obj = input as Record<string, unknown>;
  const rawArgs = obj['args'];
  const args =
    Array.isArray(rawArgs) && rawArgs.every((a) => typeof a === 'string')
      ? (rawArgs as string[])
      : undefined;
  const rawStdin = obj['stdin'];
  const stdin = typeof rawStdin === 'string' ? rawStdin : undefined;
  return {
    ...(args !== undefined ? { args } : {}),
    ...(stdin !== undefined ? { stdin } : {}),
  };
}

/**
 * Build a remote-execution adapter that provisions a host, installs the
 * required harness (e.g. Claude Code / Codex CLI), and drives it as an agent.
 * This is the concrete "one real remote adapter" the registry integrates for
 * M9; other remote targets are the same adapter with a different host and
 * capability set.
 */
export function createRemoteExecutionAdapter(
  config: Pick<RemoteExecutionAdapterConfig, 'id' | 'name' | 'version' | 'host'> &
    Partial<Pick<RemoteExecutionAdapterConfig, 'connectionTimeoutMs' | 'cancelGraceMs'>>,
  transport: RemoteTransport,
): RemoteExecutionAdapter {
  const capability: CapabilityDescriptor = {
    id: 'code.agent.run',
    title: 'Run an agent harness on a remote host',
    inputSchema: {
      type: 'object',
      properties: {
        args: { type: 'array', items: { type: 'string' } },
        stdin: { type: 'string' },
      },
    },
    outputSchema: { type: 'object' },
    streaming: true,
    cancellable: true,
    resumable: false,
    requiredPermissions: [
      { kind: 'network_egress' },
      { kind: 'command_exec' },
    ],
    costHint: 'high',
    latencyHint: 'high',
  };

  return new RemoteExecutionAdapter(
    {
      ...config,
      capabilities: [capability],
    },
    transport,
  );
}
