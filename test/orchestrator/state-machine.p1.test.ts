import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '@main/db/store';
import { AuditLog } from '@main/domain/audit-log';
import { WorkspaceService } from '@main/domain/workspace-service';
import {
  TaskStateMachine,
  TransitionCommitError,
  isTerminal,
  legalTargets,
} from '@main/orchestrator/state-machine';
import type { TaskState } from '@shared/domain';
import { fc } from '../helpers/fast-check';

// Property 1 — Durable transitions (Validates: Requirements 4.2, 4.3).
//
// 4.2: a transition commits a TaskEvent(kind='transition') + the new Task.state
//      + a checkpoint as ONE atomic unit, BEFORE any side effect of the new
//      state runs.
// 4.3: if that durable commit fails, the task stays in its pre-transition
//      state, NO side effect of the attempted new state runs, and an
//      Audit_Event is appended — with no partial writes left behind.
//
// The dedicated P1 harness walks the TRANSITION_TABLE from CREATED to build
// random *legal* transition sequences, then asserts the atomic-before-side-
// effect invariant after every step, plus the failed-commit rollback property.

let workDir: string;
let store: SqliteStore;
let audit: AuditLog;
let sm: TaskStateMachine;
let workspaceId: string;

function seedTask(state: TaskState = 'CREATED'): string {
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

/** Count durable rows currently persisted for a task. */
function counts(taskId: string): {
  events: number;
  checkpoints: number;
  state: TaskState | undefined;
} {
  const events = (
    store.db
      .prepare(`SELECT COUNT(*) AS c FROM task_events WHERE task_id = ?`)
      .get(taskId) as { c: number }
  ).c;
  const checkpoints = (
    store.db
      .prepare(`SELECT COUNT(*) AS c FROM checkpoints WHERE task_id = ?`)
      .get(taskId) as { c: number }
  ).c;
  const state = sm.getTask(taskId)?.state;
  return { events, checkpoints, state };
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'conductor-sm-p1-'));
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

/**
 * An arbitrary that produces a legal transition *walk* starting at CREATED.
 * At each step it chooses one of the current state's legal targets (if any),
 * stopping when it reaches a terminal state or runs out of planned steps. The
 * resulting path contains only transitions that exist in the Transition_Table,
 * so every element is expected to commit durably.
 */
function legalWalk(maxLen: number): fc.Arbitrary<TaskState[]> {
  // A stream of random unit floats drives the per-step target choice; the walk
  // is derived deterministically from them so shrinking stays meaningful.
  return fc
    .array(fc.double({ min: 0, max: 1, noNaN: true }), {
      minLength: 0,
      maxLength: maxLen,
    })
    .map((choices) => {
      const path: TaskState[] = [];
      let current: TaskState = 'CREATED';
      for (const choice of choices) {
        if (isTerminal(current)) break;
        const targets = legalTargets(current);
        if (targets.length === 0) break;
        const idx = Math.min(
          targets.length - 1,
          Math.floor(choice * targets.length),
        );
        const next = targets[idx] as TaskState;
        path.push(next);
        current = next;
      }
      return path;
    });
}

describe('P1 — durable write-ahead transitions', () => {
  it('commits event + state + checkpoint atomically before any side effect, across random legal walks', () => {
    fc.assert(
      fc.property(
        legalWalk(12),
        // Per-step flags for verified/snapshot so the committed checkpoint
        // content varies without ever making a transition illegal.
        fc.array(fc.boolean(), { minLength: 12, maxLength: 12 }),
        (path, verifiedFlags) => {
          const taskId = seedTask('CREATED');

          // Side effects are only permitted AFTER the durable commit returns.
          // We record, for each step, a snapshot of the durable rows captured
          // from inside the "side effect" — proving the commit happened first.
          const sideEffects: Array<{
            to: TaskState;
            events: number;
            checkpoints: number;
            state: TaskState | undefined;
          }> = [];

          let from: TaskState = 'CREATED';
          path.forEach((to, i) => {
            const result = sm.transition({
              taskId,
              to,
              snapshot: { step: i, note: `${from}->${to}` },
              verified: verifiedFlags[i] ?? false,
            });

            // The primitive returns only after the atomic commit. The returned
            // view must already reflect the new state, event, and checkpoint.
            expect(result.task.state).toBe(to);
            expect(result.event.kind).toBe('transition');
            expect(result.event.payload).toMatchObject({ from, to });
            expect(result.checkpoint.state).toBe(to);

            // Model the side effect of the new state: it may ONLY observe a
            // fully-committed world. Capture durable counts at side-effect time.
            const observed = counts(taskId);
            sideEffects.push({ to, ...observed });

            // Atomicity: after step i there are exactly i+1 events and i+1
            // checkpoints, and the persisted state equals the target.
            expect(observed.events).toBe(i + 1);
            expect(observed.checkpoints).toBe(i + 1);
            expect(observed.state).toBe(to);

            // The transition event is durably present and consistent.
            const lastEvent = store.db
              .prepare(
                `SELECT kind, payload FROM task_events
                 WHERE task_id = ? ORDER BY created_at ASC, rowid ASC`,
              )
              .all(taskId) as { kind: string; payload: string }[];
            expect(lastEvent).toHaveLength(i + 1);
            const payload = JSON.parse(
              lastEvent[i]?.payload ?? '{}',
            ) as Record<string, unknown>;
            expect(lastEvent[i]?.kind).toBe('transition');
            expect(payload).toMatchObject({ from, to });

            // The checkpoint for this step is durably present at the new state.
            const cps = store.db
              .prepare(
                `SELECT state FROM checkpoints
                 WHERE task_id = ? ORDER BY created_at ASC, rowid ASC`,
              )
              .all(taskId) as { state: string }[];
            expect(cps).toHaveLength(i + 1);
            expect(cps[i]?.state).toBe(to);

            // When the transition recorded a verified outcome, the task now
            // points at that verified checkpoint.
            if (verifiedFlags[i] === true) {
              expect(sm.getTask(taskId)?.lastVerifiedCheckpointId).toBe(
                result.checkpoint.id,
              );
            }

            from = to;
          });

          // Every modeled side effect ran against a fully-committed world: the
          // observed counts increase by exactly one per step and track state.
          sideEffects.forEach((se, i) => {
            expect(se.events).toBe(i + 1);
            expect(se.checkpoints).toBe(i + 1);
            expect(se.state).toBe(path[i]);
          });

          // The final durable state equals the walk's last state (or CREATED
          // for an empty walk).
          const finalState = path.length === 0 ? 'CREATED' : path[path.length - 1];
          expect(sm.getTask(taskId)?.state).toBe(finalState);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('on a failed commit leaves the pre-transition state with no partial writes and runs no side effect', () => {
    fc.assert(
      fc.property(legalWalk(8), (path) => {
        const taskId = seedTask('CREATED');

        // Advance the task partway along a legal walk so the failed commit is
        // attempted from an arbitrary reachable state.
        let from: TaskState = 'CREATED';
        for (const to of path) {
          sm.transition({ taskId, to, snapshot: { note: `${from}->${to}` } });
          from = to;
        }

        const before = counts(taskId);
        const auditBefore = audit.list().length;

        // A legal target from the current state, but the commit is forced to
        // fail via a FOREIGN KEY violation (step_id references a missing step).
        // The whole atomic unit must roll back.
        const targets = legalTargets(from);
        if (targets.length === 0) {
          // Terminal: nothing to attempt. Nothing changed, trivially holds.
          return;
        }
        const attempted = targets[0] as TaskState;

        let sideEffectRan = false;
        expect(() => {
          sm.transition({
            taskId,
            to: attempted,
            stepId: 'nonexistent-step-id',
          });
          // Unreachable: any side effect would run only past this point.
          sideEffectRan = true;
        }).toThrow(TransitionCommitError);

        // No side effect of the attempted new state ran.
        expect(sideEffectRan).toBe(false);

        // Pre-transition state preserved; no partial event/checkpoint written.
        const after = counts(taskId);
        expect(after.state).toBe(from);
        expect(after.events).toBe(before.events);
        expect(after.checkpoints).toBe(before.checkpoints);

        // Exactly one Audit_Event recording the failed commit was appended.
        const failed = audit
          .list()
          .filter((e) => e.action === 'task.transition.commit_failed');
        expect(failed.length).toBeGreaterThanOrEqual(1);
        expect(failed[failed.length - 1]?.target).toBe(taskId);
        expect(audit.list().length).toBe(auditBefore + 1);
      }),
      { numRuns: 100 },
    );
  });
});
