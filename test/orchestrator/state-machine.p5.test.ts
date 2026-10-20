import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fc } from '../helpers/fast-check';
import { SqliteStore } from '@main/db/store';
import { AuditLog } from '@main/domain/audit-log';
import { WorkspaceService } from '@main/domain/workspace-service';
import {
  IllegalTransitionError,
  TASK_STATES,
  TaskStateMachine,
  isLegalTransition,
} from '@main/orchestrator/state-machine';
import type { TaskState } from '@shared/domain';

// ---------------------------------------------------------------------------
// Property 5: Legal transitions only
// Validates: Requirements 4.4, 4.5
//
// The dedicated P5 property test. It generates random (from-state, target-state)
// pairs drawn from the full 11×11 cross product of Task_States and asserts the
// single invariant that the Transition_Table is the sole authority on legality
// (Requirement 4.4): a transition succeeds IFF it is present in the table. For a
// present transition the task lands in the target state. For an absent one the
// Orchestrator rejects it, leaves the task in its current state, and appends a
// `task.transition.rejected` Audit_Event — with no TaskEvent or checkpoint
// written for the rejected attempt (Requirement 4.5).
// ---------------------------------------------------------------------------

let workDir: string;
let store: SqliteStore;
let audit: AuditLog;
let sm: TaskStateMachine;
let workspaceId: string;

// Insert a task directly in a chosen state so an individual transition can be
// exercised without driving the full lifecycle.
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

function taskEventCount(taskId: string): number {
  return (
    store.db
      .prepare(`SELECT COUNT(*) AS c FROM task_events WHERE task_id = ?`)
      .get(taskId) as { c: number }
  ).c;
}

function checkpointCount(taskId: string): number {
  return (
    store.db
      .prepare(`SELECT COUNT(*) AS c FROM checkpoints WHERE task_id = ?`)
      .get(taskId) as { c: number }
  ).c;
}

function rejectedEventsFor(taskId: string) {
  return audit
    .list()
    .filter(
      (e) => e.action === 'task.transition.rejected' && e.target === taskId,
    );
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'conductor-sm-p5-'));
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

// A (from, to) pair drawn from the full cross product of the 11 Task_States.
const statePairArb = fc.record({
  from: fc.constantFrom(...TASK_STATES),
  to: fc.constantFrom(...TASK_STATES),
});

describe('Property 5: legal transitions only', () => {
  it('a transition succeeds IFF it is present in the Transition_Table', () => {
    fc.assert(
      fc.property(statePairArb, ({ from, to }) => {
        const taskId = seedTask(from);
        const legal = isLegalTransition(from, to);

        if (legal) {
          // Present in the table → the transition is permitted and the task
          // lands in the target state, with exactly one event + checkpoint.
          const result = sm.transition({ taskId, to });
          expect(result.task.state).toBe(to);
          expect(sm.getTask(taskId)?.state).toBe(to);
          expect(taskEventCount(taskId)).toBe(1);
          expect(checkpointCount(taskId)).toBe(1);
          // A permitted transition records no rejection.
          expect(rejectedEventsFor(taskId)).toHaveLength(0);
        } else {
          // Absent from the table → rejected, state unchanged, audited, and no
          // durable task write occurred (Requirement 4.5).
          expect(() => sm.transition({ taskId, to })).toThrow(
            IllegalTransitionError,
          );
          expect(sm.getTask(taskId)?.state).toBe(from);
          expect(taskEventCount(taskId)).toBe(0);
          expect(checkpointCount(taskId)).toBe(0);

          const rejected = rejectedEventsFor(taskId);
          expect(rejected).toHaveLength(1);
          expect(rejected[0]?.actor).toBe('orchestrator');
          expect(rejected[0]?.redactedPayload).toMatchObject({ from, to });
        }
      }),
      { numRuns: 300 },
    );
  });
});
