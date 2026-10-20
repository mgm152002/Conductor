import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '@main/db/store';
import { AuditLog } from '@main/domain/audit-log';
import { Registry } from '@main/registry/registry';
import { PermissionService } from '@main/domain/permission-service';
import { WorkspaceService } from '@main/domain/workspace-service';
import { TaskStateMachine } from '@main/orchestrator/state-machine';
import { TaskCanceller } from '@main/orchestrator/cancellation';
import { Orchestrator } from '@main/orchestrator/orchestrator';
import { PLACEHOLDER_PLAN_CAPABILITY } from '@main/orchestrator/planner';
import type { CriterionEvaluator } from '@main/orchestrator/verifier';
import { makeFakeAdapter } from '../fakes/fake-adapter';
import { fc } from '../helpers/fast-check';
import type { CapabilityDescriptor } from '@shared/adapter';
import type { TaskState } from '@shared/domain';

// Property 3 — No false completion (Validates: Requirements 7.2, 7.3, 7.6).
//
// 7.2: a task reaches COMPLETED ONLY AFTER a verification pass records EVERY
//      acceptance criterion as satisfied.
// 7.3: an adapter session exit code of 0 is NEVER on its own sufficient to
//      complete a task — the adversarial input here is exactly the one the
//      exit code lies about: the fake adapter always exits 0, yet the task
//      must still not complete when any criterion fails.
// 7.6: when a task enters COMPLETED, a VERIFIED checkpoint referencing the
//      verification pass outcome has been recorded (lastVerifiedCheckpointId
//      set, checkpoint.verified = 1).
//
// This harness generates random sets of acceptance criteria with random
// per-criterion pass/fail outcomes (including the adversarial
// exit-code-0-with-failing-criteria case, since the routed fake adapter always
// exits 0), drives each task to VERIFYING through the REAL runSteps path, runs
// verifyTask, and asserts the load-bearing IFF:
//
//   COMPLETED  ⟺  every criterion satisfied  ∧  a verified checkpoint present
//
// Whenever any criterion fails, the task is FAILED (or RECOVERABLE_INTERRUPTION
// under a future recovery routing) and NEVER COMPLETED, and no verified
// checkpoint is left behind.

let store: SqliteStore;
let audit: AuditLog;
let workspaces: WorkspaceService;
let stateMachine: TaskStateMachine;
let permissions: PermissionService;
let tmpRoot: string;
let workspaceId: string;

/** A registry whose single adapter declares the placeholder planner capability. */
function routableRegistry(): Registry {
  const capability: CapabilityDescriptor = {
    id: PLACEHOLDER_PLAN_CAPABILITY,
    title: 'Fulfill objective (fake)',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    streaming: true,
    cancellable: true,
    resumable: false,
    requiredPermissions: [],
  };
  const reg = new Registry();
  // The fake adapter ALWAYS exits 0 — this is the adversarial signal for
  // Requirement 7.3: exit code 0 must never by itself complete a task.
  reg.register(
    makeFakeAdapter({
      record: {
        id: 'planner-fake',
        name: 'Planner Fake',
        capabilities: [capability],
      },
      script: { result: { status: 'succeeded', exitCode: 0 } },
    }),
  );
  return reg;
}

function buildOrchestrator(evaluator: CriterionEvaluator): Orchestrator {
  const registry = routableRegistry();
  const canceller = new TaskCanceller(store, stateMachine, registry, audit);
  return new Orchestrator(store, stateMachine, workspaces, canceller, audit, {
    registry,
    permissions,
    criterionEvaluator: evaluator,
  });
}

/** Create a task with the given acceptance criteria and drive it to VERIFYING. */
async function createVerifying(
  orchestrator: Orchestrator,
  acceptanceCriteria: string[],
): Promise<string> {
  const task = await orchestrator.createTask({
    workspaceId,
    objective: 'do the thing',
    acceptanceCriteria,
  });
  const planned = await orchestrator.beginExecution(task.id);
  expect(planned).toBe('PLANNING');
  const run = await orchestrator.runSteps(task.id);
  // The adapter exited 0, so the task is sitting in VERIFYING awaiting the
  // verification pass — exit-code-0 has NOT completed it.
  expect(run.state).toBe('VERIFYING');
  return task.id;
}

function taskState(taskId: string): TaskState {
  return (
    store.db.prepare('SELECT state FROM tasks WHERE id = ?').get(taskId) as {
      state: TaskState;
    }
  ).state;
}

beforeEach(async () => {
  store = new SqliteStore(':memory:');
  await store.migrate();
  audit = new AuditLog(store);
  workspaces = new WorkspaceService(store);
  stateMachine = new TaskStateMachine(store, audit);
  permissions = new PermissionService(store, audit);
  tmpRoot = mkdtempSync(join(tmpdir(), 'conductor-p3-'));
  workspaceId = workspaces.create({ name: 'WS', rootPath: tmpRoot }).id;
});

afterEach(() => {
  store.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('P3 — no false completion', () => {
  it('reaches COMPLETED iff every criterion is satisfied, with a verified checkpoint, never on exit-code-0 alone', async () => {
    await fc.assert(
      fc.asyncProperty(
        // A random, deterministically-labeled set of acceptance criteria. An
        // empty set is included (vacuously all-satisfied). Labels are unique
        // so the per-criterion verdict lookup below is unambiguous.
        fc
          .array(fc.boolean(), { minLength: 0, maxLength: 6 })
          .map((verdicts) =>
            verdicts.map((satisfied, index) => ({
              criterion: `c${index}`,
              satisfied,
            })),
          ),
        async (criteria) => {
          // The per-criterion evaluator returns the generated verdict for each
          // criterion — the ONLY success signal Property 3 permits. It never
          // consults the adapter exit code (which is 0 for every run here).
          const verdictByCriterion = new Map(
            criteria.map((c) => [c.criterion, c.satisfied]),
          );
          const evaluator: CriterionEvaluator = ({ criterion, index }) => ({
            criterion,
            index,
            satisfied: verdictByCriterion.get(criterion) ?? false,
            detail: `evaluated ${criterion}`,
          });

          const orchestrator = buildOrchestrator(evaluator);
          const taskId = await createVerifying(
            orchestrator,
            criteria.map((c) => c.criterion),
          );

          const result = await orchestrator.verifyTask(taskId);

          const allSatisfied = criteria.every((c) => c.satisfied);
          const persisted = taskState(taskId);

          if (allSatisfied) {
            // ⇒ COMPLETED with a verified checkpoint referencing the outcome.
            expect(result.outcome).toBe('completed');
            expect(result.state).toBe('COMPLETED');
            expect(persisted).toBe('COMPLETED');
            expect(result.failed).toHaveLength(0);

            // 7.6: a VERIFIED checkpoint was recorded and the task points at it.
            expect(result.verifiedCheckpointId).toBeDefined();
            const cp = store.db
              .prepare(
                'SELECT verified, snapshot FROM checkpoints WHERE id = ?',
              )
              .get(result.verifiedCheckpointId!) as {
              verified: number;
              snapshot: string;
            };
            expect(cp.verified).toBe(1);

            const task = orchestrator.getTask(taskId);
            expect(task?.lastVerifiedCheckpointId).toBe(
              result.verifiedCheckpointId,
            );

            // The verified checkpoint references THIS verification pass outcome.
            const snapshot = JSON.parse(cp.snapshot) as {
              allSatisfied?: boolean;
              criteria?: { satisfied: boolean }[];
            };
            expect(snapshot.allSatisfied).toBe(true);
            expect(snapshot.criteria).toHaveLength(criteria.length);
          } else {
            // ⇐ at least one criterion failed: NEVER COMPLETED. The task is
            // FAILED (or RECOVERABLE_INTERRUPTION under future recovery
            // routing) and no verified checkpoint is left behind.
            expect(result.outcome).not.toBe('completed');
            expect(persisted).not.toBe('COMPLETED');
            expect(['FAILED', 'RECOVERABLE_INTERRUPTION']).toContain(persisted);
            expect(result.failed.length).toBeGreaterThan(0);
            expect(result.verifiedCheckpointId).toBeUndefined();

            const task = orchestrator.getTask(taskId);
            expect(task?.lastVerifiedCheckpointId).toBeUndefined();

            // No verified checkpoint exists for this task at all.
            const verifiedCount = (
              store.db
                .prepare(
                  'SELECT COUNT(*) AS c FROM checkpoints WHERE task_id = ? AND verified = 1',
                )
                .get(taskId) as { c: number }
            ).c;
            expect(verifiedCount).toBe(0);
          }
        },
      ),
      { numRuns: 100 },
    );
    // Each run drives a full createTask → plan → runSteps → verify cycle
    // against real SQLite, so the 100-run property needs headroom past the
    // default 5s per-test budget.
  }, 60_000);
});
