import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '@main/db/store';
import { AuditLog } from '@main/domain/audit-log';
import { Registry } from '@main/registry/registry';
import { TaskStateMachine } from '@main/orchestrator/state-machine';
import {
  DEFAULT_ACK_TIMEOUT_MS,
  TaskCanceller,
  type CancellationClock,
} from '@main/orchestrator/cancellation';
import type { AgentSessionStatus, TaskState } from '@shared/domain';
import { makeFakeAdapter, FakeAdapter } from '../fakes/fake-adapter';

// A controllable timer seam: scheduled callbacks fire only when the test calls
// `advance()`, so the 30-second acknowledgment window is exercised without any
// real delay.
class FakeClock implements CancellationClock {
  private pending = new Map<number, { handler: () => void; dueAt: number }>();
  private seq = 0;
  private nowMs = 0;

  setTimeout(handler: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.pending.set(id, { handler, dueAt: this.nowMs + ms });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  /** Advance time, firing every timer whose deadline has now passed. */
  advance(ms: number): void {
    this.nowMs += ms;
    for (const [id, timer] of [...this.pending.entries()]) {
      if (timer.dueAt <= this.nowMs) {
        this.pending.delete(id);
        timer.handler();
      }
    }
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}

let store: SqliteStore;
let audit: AuditLog;
let registry: Registry;
let stateMachine: TaskStateMachine;

const WORKSPACE_ID = 'ws-1';

beforeEach(async () => {
  store = new SqliteStore(':memory:');
  await store.migrate();
  // A workspace is required by the tasks foreign key.
  store.db
    .prepare(
      `INSERT INTO workspaces (id, name, root_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(WORKSPACE_ID, 'WS', '/tmp/ws', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');

  audit = new AuditLog(store);
  registry = new Registry();
  stateMachine = new TaskStateMachine(store, audit);
});

afterEach(() => {
  store.close();
});

function seedTask(state: TaskState): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  store.db
    .prepare(
      `INSERT INTO tasks (id, workspace_id, objective, acceptance_criteria,
                          state, context_refs, created_at, updated_at)
       VALUES (?, ?, ?, '[]', ?, '[]', ?, ?)`,
    )
    .run(id, WORKSPACE_ID, 'do the thing', state, now, now);
  return id;
}

function seedSession(
  taskId: string,
  adapterId: string,
  status: AgentSessionStatus = 'live',
): string {
  const id = randomUUID();
  store.db
    .prepare(
      `INSERT INTO agent_sessions (id, task_id, adapter_id, external_ref,
                                   status, resumable, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(id, taskId, adapterId, `ext-${id}`, status, new Date().toISOString());
  return id;
}

function sessionStatus(sessionId: string): AgentSessionStatus {
  const row = store.db
    .prepare('SELECT status FROM agent_sessions WHERE id = ?')
    .get(sessionId) as { status: AgentSessionStatus };
  return row.status;
}

function taskState(taskId: string): TaskState {
  const row = store.db
    .prepare('SELECT state FROM tasks WHERE id = ?')
    .get(taskId) as { state: TaskState };
  return row.state;
}

describe('TaskCanceller.cancelTask', () => {
  it('transitions a non-terminal task toward CANCELLED and delivers cancellation to every in-flight session', async () => {
    const taskId = seedTask('RUNNING');
    const adapterA = makeFakeAdapter({ record: { id: 'adapter-a' } });
    const adapterB = makeFakeAdapter({ record: { id: 'adapter-b' } });
    registry.register(adapterA);
    registry.register(adapterB);
    const sessA = seedSession(taskId, 'adapter-a', 'live');
    const sessB = seedSession(taskId, 'adapter-b', 'starting');

    const canceller = new TaskCanceller(store, stateMachine, registry, audit, {
      clock: new FakeClock(),
    });
    const result = await canceller.cancelTask(taskId);

    expect(result.state).toBe('CANCELLED');
    expect(result.alreadyTerminal).toBe(false);
    expect(taskState(taskId)).toBe('CANCELLED');

    // Every in-flight session received cancel and acknowledged (the fake's
    // cancel resolves immediately).
    expect(adapterA.calls.cancelled).toHaveLength(1);
    expect(adapterB.calls.cancelled).toHaveLength(1);
    expect(adapterA.calls.cancelled[0]?.sessionId).toBe(sessA);
    expect(adapterB.calls.cancelled[0]?.sessionId).toBe(sessB);
    expect(result.sessions.map((s) => s.disposition)).toEqual([
      'acknowledged',
      'acknowledged',
    ]);
    expect(sessionStatus(sessA)).toBe('exited');
    expect(sessionStatus(sessB)).toBe('exited');
  });

  it('skips sessions that are not in-flight', async () => {
    const taskId = seedTask('RUNNING');
    const adapter = makeFakeAdapter({ record: { id: 'adapter-a' } });
    registry.register(adapter);
    seedSession(taskId, 'adapter-a', 'exited');
    seedSession(taskId, 'adapter-a', 'orphaned');

    const canceller = new TaskCanceller(store, stateMachine, registry, audit, {
      clock: new FakeClock(),
    });
    const result = await canceller.cancelTask(taskId);

    expect(result.sessions).toHaveLength(0);
    expect(adapter.calls.cancelled).toHaveLength(0);
    expect(taskState(taskId)).toBe('CANCELLED');
  });

  it('force-terminates a session that does not acknowledge within 30 seconds and appends an Audit_Event', async () => {
    const taskId = seedTask('RUNNING');
    // An adapter whose cancel() never resolves models a non-acknowledging
    // session. We subclass the fake to return a pending promise from cancel().
    class NeverAcksAdapter extends FakeAdapter {
      override async cancel(): Promise<void> {
        return new Promise<void>(() => {
          /* never resolves */
        });
      }
    }
    const adapter = new NeverAcksAdapter({ record: { id: 'adapter-stuck' } });
    registry.register(adapter);
    const sessId = seedSession(taskId, 'adapter-stuck', 'live');

    const clock = new FakeClock();
    const canceller = new TaskCanceller(store, stateMachine, registry, audit, {
      clock,
    });

    const resultPromise = canceller.cancelTask(taskId);
    // Let the transition + cancel delivery run, then blow past the 30s window.
    await Promise.resolve();
    clock.advance(DEFAULT_ACK_TIMEOUT_MS);
    const result = await resultPromise;

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.disposition).toBe('force_terminated');
    expect(sessionStatus(sessId)).toBe('orphaned');
    expect(taskState(taskId)).toBe('CANCELLED');

    const forceEvents = audit
      .list()
      .filter((e) => e.action === 'task.cancel.force_terminated');
    expect(forceEvents).toHaveLength(1);
    expect(forceEvents[0]?.target).toBe(taskId);
  });

  it('does not force-terminate a session that acknowledges before the window elapses', async () => {
    const taskId = seedTask('RUNNING');
    const adapter = makeFakeAdapter({ record: { id: 'adapter-a' } });
    registry.register(adapter);
    const sessId = seedSession(taskId, 'adapter-a', 'live');

    const clock = new FakeClock();
    const canceller = new TaskCanceller(store, stateMachine, registry, audit, {
      clock,
    });
    const result = await canceller.cancelTask(taskId);

    // Advancing time after acknowledgment must not retroactively force-terminate.
    clock.advance(DEFAULT_ACK_TIMEOUT_MS * 2);

    expect(result.sessions[0]?.disposition).toBe('acknowledged');
    expect(sessionStatus(sessId)).toBe('exited');
    expect(
      audit.list().filter((e) => e.action === 'task.cancel.force_terminated'),
    ).toHaveLength(0);
    // The acknowledgment timer was cleared, so no timers remain pending.
    expect(clock.pendingCount).toBe(0);
  });

  it('force-terminates when the owning adapter is not registered', async () => {
    const taskId = seedTask('RUNNING');
    const sessId = seedSession(taskId, 'missing-adapter', 'live');

    const canceller = new TaskCanceller(store, stateMachine, registry, audit, {
      clock: new FakeClock(),
    });
    const result = await canceller.cancelTask(taskId);

    expect(result.sessions[0]?.disposition).toBe('force_terminated');
    expect(sessionStatus(sessId)).toBe('orphaned');
  });

  it('is a no-op for an already-terminal task', async () => {
    const taskId = seedTask('COMPLETED');
    const adapter = makeFakeAdapter({ record: { id: 'adapter-a' } });
    registry.register(adapter);
    seedSession(taskId, 'adapter-a', 'live');

    const canceller = new TaskCanceller(store, stateMachine, registry, audit, {
      clock: new FakeClock(),
    });
    const result = await canceller.cancelTask(taskId);

    expect(result.alreadyTerminal).toBe(true);
    expect(result.state).toBe('COMPLETED');
    expect(result.sessions).toHaveLength(0);
    expect(adapter.calls.cancelled).toHaveLength(0);
    expect(taskState(taskId)).toBe('COMPLETED');
  });

  it('throws when the task does not exist', async () => {
    const canceller = new TaskCanceller(store, stateMachine, registry, audit, {
      clock: new FakeClock(),
    });
    await expect(canceller.cancelTask('nope')).rejects.toThrow(/not found/);
  });

  it('cancels from BLOCKED and WAITING_FOR_APPROVAL (CANCELLED legal from every non-terminal state)', async () => {
    for (const from of ['BLOCKED', 'WAITING_FOR_APPROVAL'] as const) {
      const taskId = seedTask(from);
      const canceller = new TaskCanceller(
        store,
        stateMachine,
        registry,
        audit,
        { clock: new FakeClock() },
      );
      const result = await canceller.cancelTask(taskId);
      expect(result.state).toBe('CANCELLED');
      expect(taskState(taskId)).toBe('CANCELLED');
    }
  });
});
