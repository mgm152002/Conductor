import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '@main/db/store';
import { AuditLog } from '@main/domain/audit-log';
import { WorkspaceService } from '@main/domain/workspace-service';
import { Registry } from '@main/registry/registry';
import { TaskStateMachine } from '@main/orchestrator/state-machine';
import {
  ResumeCenter,
  classify,
  type MonotonicClock,
} from '@main/orchestrator/resume-center';
import { DiskManagedStorage } from '@main/storage/managed-storage';
import { makeFakeAdapter } from '../fakes/fake-adapter';
import type {
  AgentSessionStatus,
  ResumeClassification,
  TaskState,
} from '@shared/domain';

// Task 11.1 — boot reconciliation and deterministic classification. These
// tests drive ResumeCenter.onBoot directly against hand-seeded task / session /
// checkpoint rows so every classification input (persisted state, session
// liveness, filesystem drift, the 10-second timeout) is controlled exactly.

let store: SqliteStore;
let audit: AuditLog;
let workspaces: WorkspaceService;
let stateMachine: TaskStateMachine;
let tmpRoot: string;
let blobRoot: string;
let workspaceId: string;

/** A monotonic clock whose `now()` returns values from a scripted queue. */
function scriptedClock(values: number[]): MonotonicClock {
  let i = 0;
  return {
    now(): number {
      const v = values[Math.min(i, values.length - 1)];
      i += 1;
      return v ?? 0;
    },
  };
}

/** Insert a task row directly in the given state and return its id. */
function seedTask(
  state: TaskState,
  opts: { objective?: string } = {},
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  store.db
    .prepare(
      `INSERT INTO tasks (id, workspace_id, objective, acceptance_criteria,
                          state, context_refs, created_at, updated_at)
       VALUES (?, ?, ?, '[]', ?, '[]', ?, ?)`,
    )
    .run(id, workspaceId, opts.objective ?? 'objective', state, now, now);
  return id;
}

/** Insert an agent_session row for a task. */
function seedSession(
  taskId: string,
  opts: {
    adapterId?: string;
    status?: AgentSessionStatus;
    exitCode?: number | null;
  } = {},
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  store.db
    .prepare(
      `INSERT INTO agent_sessions
         (id, task_id, adapter_id, external_ref, status, resumable,
          last_heartbeat_at, exit_code, created_at)
       VALUES (?, ?, ?, 'ref', ?, 0, NULL, ?, ?)`,
    )
    .run(
      id,
      taskId,
      opts.adapterId ?? 'fake-adapter',
      opts.status ?? 'live',
      opts.exitCode ?? null,
      now,
    );
  return id;
}

/** Insert a checkpoint row for a task; returns the checkpoint id. */
function seedCheckpoint(
  taskId: string,
  state: TaskState,
  opts: { verified?: boolean; createdAt?: string } = {},
): string {
  const id = randomUUID();
  const now = opts.createdAt ?? new Date().toISOString();
  store.db
    .prepare(
      `INSERT INTO checkpoints (id, task_id, step_id, state, snapshot, verified, created_at)
       VALUES (?, ?, NULL, ?, '{}', ?, ?)`,
    )
    .run(id, taskId, state, opts.verified === true ? 1 : 0, now);
  return id;
}

/** Record a kind='artifact' task_event referencing a blob id. */
function seedArtifactEvent(
  taskId: string,
  artifactId: string,
  opts: { createdAt?: string } = {},
): void {
  store.db
    .prepare(
      `INSERT INTO task_events (id, task_id, step_id, kind, payload, created_at)
       VALUES (?, ?, NULL, 'artifact', ?, ?)`,
    )
    .run(
      randomUUID(),
      taskId,
      JSON.stringify({ artifactId }),
      opts.createdAt ?? new Date().toISOString(),
    );
}

function taskState(taskId: string): TaskState {
  return (
    store.db.prepare('SELECT state FROM tasks WHERE id = ?').get(taskId) as {
      state: TaskState;
    }
  ).state;
}

function sessionStatus(sessionId: string): AgentSessionStatus {
  return (
    store.db
      .prepare('SELECT status FROM agent_sessions WHERE id = ?')
      .get(sessionId) as { status: AgentSessionStatus }
  ).status;
}

/** A registry whose single adapter answers liveness as scripted. */
function registryWithLiveness(alive: boolean, adapterId = 'fake-adapter'): Registry {
  const reg = new Registry();
  reg.register(
    makeFakeAdapter({
      record: { id: adapterId },
      script: { livenessDefault: alive },
    }),
  );
  return reg;
}

function makeResumeCenter(opts: {
  registry?: Registry;
  storage?: DiskManagedStorage;
  clock?: MonotonicClock;
  timeoutMs?: number;
}): ResumeCenter {
  return new ResumeCenter(
    store,
    stateMachine,
    opts.registry ?? new Registry(),
    audit,
    {
      ...(opts.storage !== undefined ? { storage: opts.storage } : {}),
      ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    },
  );
}

beforeEach(async () => {
  store = new SqliteStore(':memory:');
  await store.migrate();
  audit = new AuditLog(store);
  workspaces = new WorkspaceService(store);
  stateMachine = new TaskStateMachine(store, audit);
  tmpRoot = mkdtempSync(join(tmpdir(), 'conductor-ws-'));
  blobRoot = mkdtempSync(join(tmpdir(), 'conductor-blob-'));
  workspaceId = workspaces.create({ name: 'WS', rootPath: tmpRoot }).id;
});

afterEach(() => {
  store.close();
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(blobRoot, { recursive: true, force: true });
});

describe('ResumeCenter.onBoot — task loading', () => {
  it('loads only non-terminal tasks', async () => {
    const running = seedTask('RUNNING');
    seedTask('COMPLETED');
    seedTask('FAILED');
    seedTask('CANCELLED');
    const planning = seedTask('PLANNING');

    const rc = makeResumeCenter({ registry: registryWithLiveness(false) });
    const snapshot = await rc.onBoot();

    const ids = snapshot.items.map((i) => i.taskId).sort();
    expect(ids).toEqual([running, planning].sort());
  });

  it('returns an empty snapshot when there are no non-terminal tasks', async () => {
    seedTask('COMPLETED');
    const rc = makeResumeCenter({});
    const snapshot = await rc.onBoot();
    expect(snapshot.items).toEqual([]);
    expect(snapshot.generatedAt).toEqual(expect.any(String));
  });
});

describe('ResumeCenter.onBoot — classification', () => {
  it('classifies a task with a provably-live session as RESUMABLE and keeps its state', async () => {
    const taskId = seedTask('RUNNING');
    const sessionId = seedSession(taskId, { status: 'starting' });

    const rc = makeResumeCenter({ registry: registryWithLiveness(true) });
    const snapshot = await rc.onBoot();

    expect(snapshot.items[0]?.classification).toBe('RESUMABLE');
    // RESUMABLE keeps the prior non-terminal state — no transition recorded.
    expect(taskState(taskId)).toBe('RUNNING');
    // The live probe persisted the session status.
    expect(sessionStatus(sessionId)).toBe('live');
  });

  it('classifies a mid-flight task with a dead session as RECOVERABLE_INTERRUPTION', async () => {
    const taskId = seedTask('RUNNING');
    const sessionId = seedSession(taskId, { exitCode: 0 });

    const rc = makeResumeCenter({ registry: registryWithLiveness(false) });
    const snapshot = await rc.onBoot();

    expect(snapshot.items[0]?.classification).toBe('RECOVERABLE_INTERRUPTION');
    expect(taskState(taskId)).toBe('RECOVERABLE_INTERRUPTION');
    // A dead session carrying an exit code reconciles to 'exited' (never 'live').
    expect(sessionStatus(sessionId)).toBe('exited');
  });

  it('reconciles a dead session with no exit code to orphaned', async () => {
    const taskId = seedTask('RUNNING');
    const sessionId = seedSession(taskId, { exitCode: null });

    const rc = makeResumeCenter({ registry: registryWithLiveness(false) });
    await rc.onBoot();

    expect(sessionStatus(sessionId)).toBe('orphaned');
  });

  it('classifies a task with no sessions as RECOVERABLE_INTERRUPTION', async () => {
    const taskId = seedTask('CONTEXT_LOADING');
    const rc = makeResumeCenter({ registry: new Registry() });
    const snapshot = await rc.onBoot();

    expect(snapshot.items[0]?.classification).toBe('RECOVERABLE_INTERRUPTION');
    expect(taskState(taskId)).toBe('RECOVERABLE_INTERRUPTION');
  });

  it('classifies a task already waiting on a decision as BLOCKED', async () => {
    const approval = seedTask('WAITING_FOR_APPROVAL');
    const blocked = seedTask('BLOCKED');
    // Even with a live session, a pending decision outranks liveness.
    seedSession(approval, { status: 'live' });

    const rc = makeResumeCenter({ registry: registryWithLiveness(true) });
    const snapshot = await rc.onBoot();

    const byId = new Map(snapshot.items.map((i) => [i.taskId, i.classification]));
    expect(byId.get(approval)).toBe('BLOCKED');
    expect(byId.get(blocked)).toBe('BLOCKED');
    // A task already waiting on a decision keeps its persisted state: the
    // pending approval is preserved verbatim rather than being clobbered to
    // BLOCKED (no WAITING_FOR_APPROVAL → BLOCKED edge exists either).
    expect(taskState(approval)).toBe('WAITING_FOR_APPROVAL');
    // Already BLOCKED stays BLOCKED (idempotent, no redundant transition).
    expect(taskState(blocked)).toBe('BLOCKED');
  });

  it('classifies a task with filesystem drift as BLOCKED', async () => {
    const storage = new DiskManagedStorage(blobRoot);
    const present = storage.put('kept', 'text/plain').id;
    const missing = randomUUID(); // never written → drift

    const taskId = seedTask('RUNNING');
    seedSession(taskId, { exitCode: 0 });
    const cp = seedCheckpoint(taskId, 'RUNNING');
    // Both artifacts referenced before the checkpoint; one blob is gone.
    const cpTime = (
      store.db.prepare('SELECT created_at FROM checkpoints WHERE id = ?').get(cp) as {
        created_at: string;
      }
    ).created_at;
    seedArtifactEvent(taskId, present, { createdAt: cpTime });
    seedArtifactEvent(taskId, missing, { createdAt: cpTime });

    const rc = makeResumeCenter({
      registry: registryWithLiveness(false),
      storage,
    });
    const snapshot = await rc.onBoot();

    expect(snapshot.items[0]?.classification).toBe('BLOCKED');
    expect(taskState(taskId)).toBe('BLOCKED');
  });

  it('does not flag drift when all referenced artifacts are present', async () => {
    const storage = new DiskManagedStorage(blobRoot);
    const a = storage.put('a').id;
    const b = storage.put('b').id;

    const taskId = seedTask('RUNNING');
    seedSession(taskId, { exitCode: 0 });
    const cp = seedCheckpoint(taskId, 'RUNNING');
    const cpTime = (
      store.db.prepare('SELECT created_at FROM checkpoints WHERE id = ?').get(cp) as {
        created_at: string;
      }
    ).created_at;
    seedArtifactEvent(taskId, a, { createdAt: cpTime });
    seedArtifactEvent(taskId, b, { createdAt: cpTime });

    const rc = makeResumeCenter({
      registry: registryWithLiveness(false),
      storage,
    });
    const snapshot = await rc.onBoot();

    expect(snapshot.items[0]?.classification).toBe('RECOVERABLE_INTERRUPTION');
  });
});

describe('ResumeCenter.onBoot — failure / timeout handling (Req 8.4)', () => {
  it('classifies BLOCKED, preserves state, and audits when a probe throws', async () => {
    const taskId = seedTask('RUNNING');
    seedSession(taskId, { adapterId: 'boom', exitCode: 0 });

    // A registry with an adapter whose probeLiveness throws.
    const reg = new Registry();
    reg.register(makeFakeAdapter({ record: { id: 'boom' } }));
    // Override the resolved adapter's probeLiveness to throw, simulating a
    // reconciliation failure for this task's session.
    const adapter = reg.resolve('boom');
    (adapter as unknown as { probeLiveness: () => Promise<boolean> }).probeLiveness =
      () => {
        throw new Error('probe exploded');
      };

    const rc = makeResumeCenter({ registry: reg });
    const snapshot = await rc.onBoot();

    expect(snapshot.items[0]?.classification).toBe('BLOCKED');
    // State is PRESERVED — no transition out of RUNNING on failure.
    expect(taskState(taskId)).toBe('RUNNING');
    const audited = audit
      .list()
      .some((e) => e.action === 'resume.reconcile.blocked');
    expect(audited).toBe(true);
  });

  it('classifies BLOCKED and preserves state when reconciliation exceeds the 10s budget', async () => {
    const taskId = seedTask('RUNNING');
    seedSession(taskId, { exitCode: 0 });

    // Clock: start at 0, then report 11s elapsed after the probe. blockOnFailure
    // then reads the clock twice more for the elapsed-ms payload.
    const clock = scriptedClock([0, 11_000, 11_000, 11_000]);
    const rc = makeResumeCenter({
      registry: registryWithLiveness(false),
      clock,
      timeoutMs: 10_000,
    });
    const snapshot = await rc.onBoot();

    expect(snapshot.items[0]?.classification).toBe('BLOCKED');
    expect(taskState(taskId)).toBe('RUNNING'); // preserved
    const audited = audit.list().some(
      (e) =>
        e.action === 'resume.reconcile.blocked' &&
        typeof e.redactedPayload === 'object' &&
        e.redactedPayload !== null &&
        (e.redactedPayload as { reason?: string }).reason === 'timeout',
    );
    expect(audited).toBe(true);
  });
});

describe('ResumeCenter.onBoot — determinism (Req 8.3; Property 2)', () => {
  it('yields the same classification on a second onBoot over unchanged inputs', async () => {
    const live = seedTask('RUNNING');
    seedSession(live, { adapterId: 'alive', status: 'starting' });
    const interrupted = seedTask('VERIFYING');
    seedSession(interrupted, { adapterId: 'dead', exitCode: 0 });
    const waiting = seedTask('WAITING_FOR_APPROVAL');

    // Distinct adapters so liveness is per-session and stable across both runs:
    // `alive` is live, `dead` is not.
    const reg = new Registry();
    reg.register(
      makeFakeAdapter({ record: { id: 'alive' }, script: { livenessDefault: true } }),
    );
    reg.register(
      makeFakeAdapter({ record: { id: 'dead' }, script: { livenessDefault: false } }),
    );

    const rc = makeResumeCenter({ registry: reg });
    const first = await rc.onBoot();
    const firstMap = classificationMap(first);

    // Second boot over the now-reconciled (but input-equivalent) state.
    const second = await rc.onBoot();
    const secondMap = classificationMap(second);

    expect(secondMap).toEqual(firstMap);
    expect(firstMap.get(live)).toBe('RESUMABLE');
    expect(firstMap.get(interrupted)).toBe('RECOVERABLE_INTERRUPTION');
    expect(firstMap.get(waiting)).toBe('BLOCKED');
  });
});

describe('ResumeCenter.snapshot — cached boot result (task 11.2)', () => {
  it('returns an empty snapshot before the first boot sweep', () => {
    const rc = makeResumeCenter({});
    const snapshot = rc.snapshot();
    expect(snapshot.items).toEqual([]);
    expect(snapshot.generatedAt).toEqual(expect.any(String));
  });

  it('serves the most recent onBoot snapshot without re-reconciling', async () => {
    const taskId = seedTask('RUNNING');
    seedSession(taskId, { status: 'starting' });

    const rc = makeResumeCenter({ registry: registryWithLiveness(true) });
    const booted = await rc.onBoot();
    const served = rc.snapshot();

    expect(served).toEqual(booted);
    expect(served.items[0]?.taskId).toBe(taskId);
  });
});

describe('classify — pure deterministic rules', () => {
  it('prioritizes a pending decision over a live session', () => {
    expect(
      classify({ state: 'WAITING_FOR_APPROVAL', anyLive: true, hadSessions: true, fsDrift: false }),
    ).toBe('BLOCKED');
    expect(
      classify({ state: 'BLOCKED', anyLive: true, hadSessions: true, fsDrift: false }),
    ).toBe('BLOCKED');
  });

  it('is RESUMABLE only when a session is live and no decision is pending', () => {
    expect(
      classify({ state: 'RUNNING', anyLive: true, hadSessions: true, fsDrift: false }),
    ).toBe('RESUMABLE');
  });

  it('is BLOCKED on filesystem drift with no live session', () => {
    expect(
      classify({ state: 'RUNNING', anyLive: false, hadSessions: true, fsDrift: true }),
    ).toBe('BLOCKED');
  });

  it('is RECOVERABLE_INTERRUPTION for a mid-flight task with no live session and no drift', () => {
    expect(
      classify({ state: 'RUNNING', anyLive: false, hadSessions: false, fsDrift: false }),
    ).toBe('RECOVERABLE_INTERRUPTION');
  });
});

function classificationMap(snapshot: {
  items: { taskId: string; classification: ResumeClassification }[];
}): Map<string, ResumeClassification> {
  return new Map(snapshot.items.map((i) => [i.taskId, i.classification]));
}
