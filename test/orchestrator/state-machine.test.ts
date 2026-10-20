import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '@main/db/store';
import { AuditLog } from '@main/domain/audit-log';
import { WorkspaceService } from '@main/domain/workspace-service';
import {
  IllegalTransitionError,
  TASK_STATES,
  TERMINAL_STATES,
  TaskStateMachine,
  TransitionCommitError,
  isLegalTransition,
  isTerminal,
  legalTargets,
} from '@main/orchestrator/state-machine';
import type { TaskState } from '@shared/domain';

let workDir: string;
let store: SqliteStore;
let audit: AuditLog;
let sm: TaskStateMachine;
let workspaceId: string;

// Insert a task directly in a chosen state so transitions can be exercised
// without the full lifecycle (which lands in task 9).
function seedTask(state: TaskState): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  store.db
    .prepare(
      `INSERT INTO tasks (id, workspace_id, objective, acceptance_criteria,
                          state, context_refs, created_at, updated_at)
       VALUES (?, ?, ?, '[]', ?, '[]', ?, ?)`,
    )
    .run(id, workspaceId, 'do the thing', state, now, now);
  return id;
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'conductor-sm-'));
  store = new SqliteStore(join(workDir, 'app.db'));
  await store.migrate();
  audit = new AuditLog(store);
  sm = new TaskStateMachine(store, audit);
  workspaceId = new WorkspaceService(store).create({
    name: 'ws',
    rootPath: workDir,
  }).id;
});

afterEach(() => {
  store.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe('migration 3 schema', () => {
  it('creates the five orchestrator tables once migrations are applied', () => {
    // Migration 3 lands the orchestrator tables; later milestones add further
    // migrations, so assert the tables exist at or beyond version 3 rather than
    // pinning the latest schema version (which advances as milestones land).
    expect(store.schemaVersion()).toBeGreaterThanOrEqual(3);
    const names = store.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((r) => (r as { name: string }).name);
    for (const t of [
      'tasks',
      'task_steps',
      'checkpoints',
      'task_events',
      'agent_sessions',
    ]) {
      expect(names).toContain(t);
    }
  });
});

describe('transition table authority', () => {
  it('encodes exactly 11 states with 3 terminal', () => {
    expect(TASK_STATES).toHaveLength(11);
    expect(TERMINAL_STATES).toEqual(['COMPLETED', 'FAILED', 'CANCELLED']);
  });

  it('terminal states have no legal targets', () => {
    for (const t of TERMINAL_STATES) {
      expect(isTerminal(t)).toBe(true);
      expect(legalTargets(t)).toHaveLength(0);
    }
  });

  it('recognizes representative legal and illegal transitions', () => {
    // From the design table.
    expect(isLegalTransition('CREATED', 'CONTEXT_LOADING')).toBe(true);
    expect(isLegalTransition('VERIFYING', 'COMPLETED')).toBe(true);
    expect(isLegalTransition('RUNNING', 'VERIFYING')).toBe(true);
    // Absent from the table.
    expect(isLegalTransition('CREATED', 'COMPLETED')).toBe(false);
    expect(isLegalTransition('CREATED', 'RUNNING')).toBe(false);
    expect(isLegalTransition('COMPLETED', 'RUNNING')).toBe(false);
  });
});

describe('transition primitive', () => {
  it('commits event + state + checkpoint atomically on a legal transition', () => {
    const taskId = seedTask('CREATED');
    const result = sm.transition({
      taskId,
      to: 'CONTEXT_LOADING',
      snapshot: { note: 'starting' },
    });

    expect(result.task.state).toBe('CONTEXT_LOADING');
    expect(sm.getTask(taskId)?.state).toBe('CONTEXT_LOADING');

    const events = store.db
      .prepare(`SELECT kind, payload FROM task_events WHERE task_id = ?`)
      .all(taskId) as { kind: string; payload: string }[];
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('transition');
    expect(JSON.parse(events[0]?.payload ?? '{}')).toMatchObject({
      from: 'CREATED',
      to: 'CONTEXT_LOADING',
    });

    const cps = store.db
      .prepare(`SELECT state, verified FROM checkpoints WHERE task_id = ?`)
      .all(taskId) as { state: string; verified: number }[];
    expect(cps).toHaveLength(1);
    expect(cps[0]?.state).toBe('CONTEXT_LOADING');
    expect(cps[0]?.verified).toBe(0);
  });

  it('records the verified checkpoint on the task when verified', () => {
    const taskId = seedTask('VERIFYING');
    const result = sm.transition({ taskId, to: 'COMPLETED', verified: true });
    expect(sm.getTask(taskId)?.lastVerifiedCheckpointId).toBe(
      result.checkpoint.id,
    );
  });

  it('rejects an illegal transition, leaves state unchanged, audits', () => {
    const taskId = seedTask('CREATED');
    expect(() => sm.transition({ taskId, to: 'COMPLETED' })).toThrow(
      IllegalTransitionError,
    );
    expect(sm.getTask(taskId)?.state).toBe('CREATED');
    // No event or checkpoint written.
    const eventCount = (
      store.db
        .prepare(`SELECT COUNT(*) AS c FROM task_events WHERE task_id = ?`)
        .get(taskId) as { c: number }
    ).c;
    expect(eventCount).toBe(0);
    const rejected = audit
      .list()
      .filter((e) => e.action === 'task.transition.rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.target).toBe(taskId);
  });

  it('refuses to leave a terminal state and audits', () => {
    const taskId = seedTask('COMPLETED');
    expect(() => sm.transition({ taskId, to: 'RUNNING' })).toThrow(
      IllegalTransitionError,
    );
    expect(sm.getTask(taskId)?.state).toBe('COMPLETED');
    expect(
      audit.list().some((e) => e.action === 'task.transition.rejected'),
    ).toBe(true);
  });

  it('on a failed commit leaves the pre-transition state and audits', () => {
    const taskId = seedTask('CREATED');
    // Force the atomic unit to fail: a FOREIGN KEY violation inside the step
    // insert rolls the whole transaction back (step_id references a step that
    // does not exist). The task must stay in CREATED and no side effect runs.
    expect(() =>
      sm.transition({
        taskId,
        to: 'CONTEXT_LOADING',
        stepId: 'nonexistent-step-id',
      }),
    ).toThrow(TransitionCommitError);

    expect(sm.getTask(taskId)?.state).toBe('CREATED');
    const eventCount = (
      store.db
        .prepare(`SELECT COUNT(*) AS c FROM task_events WHERE task_id = ?`)
        .get(taskId) as { c: number }
    ).c;
    expect(eventCount).toBe(0);
    const failed = audit
      .list()
      .filter((e) => e.action === 'task.transition.commit_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.target).toBe(taskId);
  });

  it('throws when the task does not exist', () => {
    expect(() =>
      sm.transition({ taskId: 'missing', to: 'CONTEXT_LOADING' }),
    ).toThrow(/not found/);
  });
});
