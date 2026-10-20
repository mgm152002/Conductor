import type { Store } from '../db/types';
import type { AuditLog } from '../domain/audit-log';
import type { Registry } from '../registry/registry';
import type { TaskStateMachine } from './state-machine';
import { isTerminal } from './state-machine';
import type { AdapterSessionHandle, AgentSession } from '@shared/adapter';
import type { AgentSessionStatus, TaskState } from '@shared/domain';

// Task cancellation (Requirement 4.7, 4.8).
//
// Cancelling a non-terminal task is two durable, ordered actions:
//
//   1. Transition the task toward CANCELLED through the write-ahead
//      `transition` primitive, so the cancelled state is committed before any
//      session side effect runs (CANCELLED is a legal target from every
//      non-terminal state in the Transition_Table).
//   2. Deliver cancellation to every in-flight adapter session of that task.
//      Each session is given up to a 30-second acknowledgment window; a session
//      that does not acknowledge within that window is force-terminated and the
//      force-termination is recorded as an Audit_Event.
//
// This module deliberately lives beside — not inside — the state machine so it
// can be added without touching the `transition` primitive, TASK_STATES, or the
// Transition_Table.
//
// The 30-second window is driven through an injectable {@link CancellationClock}
// seam so tests can advance time deterministically instead of waiting in real
// wall-clock seconds.

/** Default acknowledgment window before a session is force-terminated (30s). */
export const DEFAULT_ACK_TIMEOUT_MS = 30_000;

// Session statuses that represent an in-flight invocation still worth
// cancelling. `exited` and `orphaned` sessions are already terminal and are
// skipped.
const IN_FLIGHT_STATUSES: ReadonlySet<AgentSessionStatus> = new Set<AgentSessionStatus>([
  'starting',
  'live',
  'unknown',
]);

/**
 * Injectable timer seam. Mirrors the shape of the global `setTimeout` /
 * `clearTimeout` pair but is swapped for a controllable fake in tests so the
 * 30-second acknowledgment timeout is exercised without real delay.
 */
export interface CancellationClock {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The real clock backed by the host timers. */
export const systemClock: CancellationClock = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

interface AgentSessionRow {
  id: string;
  task_id: string;
  adapter_id: string;
  external_ref: string | null;
  status: AgentSessionStatus;
  resumable: number;
  last_heartbeat_at: string | null;
  exit_code: number | null;
  created_at: string;
}

function rowToSession(row: AgentSessionRow): AgentSession {
  return {
    id: row.id,
    taskId: row.task_id,
    adapterId: row.adapter_id,
    ...(row.external_ref !== null ? { externalRef: row.external_ref } : {}),
    status: row.status,
    resumable: row.resumable === 1,
    ...(row.last_heartbeat_at !== null
      ? { lastHeartbeatAt: row.last_heartbeat_at }
      : {}),
    ...(row.exit_code !== null ? { exitCode: row.exit_code } : {}),
    createdAt: row.created_at,
  };
}

/** How a single session's cancellation resolved. */
export type SessionCancelDisposition = 'acknowledged' | 'force_terminated';

export interface SessionCancelOutcome {
  sessionId: string;
  adapterId: string;
  disposition: SessionCancelDisposition;
}

/** The result of cancelling a task. */
export interface CancelTaskResult {
  taskId: string;
  /** The state the task transitioned into (CANCELLED unless already terminal). */
  state: TaskState;
  /** Per-session outcomes, in the order the sessions were delivered cancel. */
  sessions: SessionCancelOutcome[];
  /** True when the task was already terminal and nothing was cancelled. */
  alreadyTerminal: boolean;
}

export interface TaskCancellerOptions {
  /** Acknowledgment window in ms before force-terminate. Defaults to 30s. */
  ackTimeoutMs?: number;
  /** Timer seam; defaults to the real host timers. */
  clock?: CancellationClock;
}

/**
 * Drives task cancellation: the durable transition toward CANCELLED plus
 * delivery of cancellation to every in-flight adapter session, with a 30-second
 * acknowledgment timeout that force-terminates unacknowledged sessions.
 */
export class TaskCanceller {
  private readonly ackTimeoutMs: number;
  private readonly clock: CancellationClock;

  constructor(
    private readonly store: Store,
    private readonly stateMachine: TaskStateMachine,
    private readonly registry: Registry,
    private readonly audit: AuditLog,
    options: TaskCancellerOptions = {},
  ) {
    this.ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
    this.clock = options.clock ?? systemClock;
  }

  /**
   * Cancel a non-terminal task (Requirement 4.7, 4.8).
   *
   * Order is load-bearing: the task is transitioned toward CANCELLED through
   * the write-ahead primitive first, so the cancelled state is durable before
   * any session is touched. Then every in-flight session is delivered
   * cancellation; a session that does not acknowledge within the 30-second
   * window is force-terminated and audited.
   *
   * A task that is already terminal is a no-op: it reports `alreadyTerminal`
   * and cancels nothing (a terminal state can never be left).
   */
  async cancelTask(taskId: string): Promise<CancelTaskResult> {
    const task = this.stateMachine.getTask(taskId);
    if (task === undefined) {
      throw new Error(`Task ${taskId} not found`);
    }

    if (isTerminal(task.state)) {
      return {
        taskId,
        state: task.state,
        sessions: [],
        alreadyTerminal: true,
      };
    }

    // 1. Durable write-ahead transition toward CANCELLED before any side
    //    effect (session cancellation) runs. CANCELLED is a legal target from
    //    every non-terminal state, so this never rejects for a live task.
    const { task: cancelled } = this.stateMachine.transition({
      taskId,
      to: 'CANCELLED',
      eventPayload: { reason: 'user-cancel' },
    });

    // 2. Deliver cancellation to every in-flight session of this task.
    //    Sessions are cancelled together (a plan runs several at once), so the
    //    wait is one acknowledgment window, not one per session. Outcomes keep
    //    session order.
    const sessions = this.loadInFlightSessions(taskId);
    const outcomes: SessionCancelOutcome[] = await Promise.all(
      sessions.map((session) => this.cancelSession(session)),
    );

    return {
      taskId,
      state: cancelled.state,
      sessions: outcomes,
      alreadyTerminal: false,
    };
  }

  /** In-flight sessions for a task, oldest first. */
  private loadInFlightSessions(taskId: string): AgentSession[] {
    const rows = this.store.db
      .prepare(
        `SELECT id, task_id, adapter_id, external_ref, status, resumable,
                last_heartbeat_at, exit_code, created_at
         FROM agent_sessions
         WHERE task_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(taskId) as AgentSessionRow[];
    return rows
      .map(rowToSession)
      .filter((session) => IN_FLIGHT_STATUSES.has(session.status));
  }

  /**
   * Deliver cancellation to a single session and race its acknowledgment
   * against the 30-second window. The adapter's `cancel()` promise resolving is
   * the acknowledgment signal; if the window elapses first the session is
   * force-terminated and an Audit_Event is appended (Requirement 4.8).
   */
  private async cancelSession(
    session: AgentSession,
  ): Promise<SessionCancelOutcome> {
    const handle: AdapterSessionHandle = {
      sessionId: session.id,
      adapterId: session.adapterId,
      ...(session.externalRef !== undefined
        ? { externalRef: session.externalRef }
        : {}),
      resumable: session.resumable,
    };

    const acknowledged = await this.deliverWithTimeout(session, handle);

    if (acknowledged) {
      this.markSessionExited(session.id, 'exited');
      return {
        sessionId: session.id,
        adapterId: session.adapterId,
        disposition: 'acknowledged',
      };
    }

    // Did not acknowledge within the window: force-terminate and audit.
    this.markSessionExited(session.id, 'orphaned');
    this.audit.append({
      actor: 'orchestrator',
      action: 'task.cancel.force_terminated',
      target: session.taskId,
      redactedPayload: {
        sessionId: session.id,
        adapterId: session.adapterId,
        reason: 'cancellation not acknowledged within timeout',
        timeoutMs: this.ackTimeoutMs,
      },
    });
    return {
      sessionId: session.id,
      adapterId: session.adapterId,
      disposition: 'force_terminated',
    };
  }

  /**
   * Call the owning adapter's `cancel()` and resolve `true` if it acknowledges
   * (the promise settles) within the acknowledgment window, or `false` if the
   * window elapses first. A thrown/rejected cancel is treated as a
   * non-acknowledgment so the session is force-terminated rather than left
   * dangling. An unresolvable adapter likewise cannot acknowledge.
   */
  private deliverWithTimeout(
    session: AgentSession,
    handle: AdapterSessionHandle,
  ): Promise<boolean> {
    let cancelPromise: Promise<void>;
    try {
      const adapter = this.registry.resolve(session.adapterId);
      cancelPromise = Promise.resolve(adapter.cancel(handle));
    } catch {
      // Adapter not registered or cancel threw synchronously: cannot be
      // acknowledged, so it must be force-terminated.
      return Promise.resolve(false);
    }

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = this.clock.setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, this.ackTimeoutMs);

      const finish = (acknowledged: boolean): void => {
        if (settled) return;
        settled = true;
        this.clock.clearTimeout(timer);
        resolve(acknowledged);
      };

      cancelPromise.then(
        () => finish(true),
        () => finish(false),
      );
    });
  }

  /** Mark a session terminal after cancellation/force-termination. */
  private markSessionExited(
    sessionId: string,
    status: Extract<AgentSessionStatus, 'exited' | 'orphaned'>,
  ): void {
    this.store.db
      .prepare(`UPDATE agent_sessions SET status = ? WHERE id = ?`)
      .run(status, sessionId);
  }
}
