import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SqliteStore } from '@main/db/store';
import { AuditLog } from '@main/domain/audit-log';
import { WorkspaceService } from '@main/domain/workspace-service';
import { PermissionService } from '@main/domain/permission-service';
import { Registry } from '@main/registry/registry';
import { TaskStateMachine } from '@main/orchestrator/state-machine';
import { TaskCanceller } from '@main/orchestrator/cancellation';
import { Orchestrator } from '@main/orchestrator/orchestrator';
import { ResumeService } from '@main/orchestrator/resume-service';
import { ResumeCenter } from '@main/orchestrator/resume-center';
import {
  PLACEHOLDER_PLAN_CAPABILITY,
  type Planner,
  type PlanDecomposition,
} from '@main/orchestrator/planner';
import { DiskManagedStorage } from '@main/storage/managed-storage';
import { makeFakeAdapter, type FakeCrashPoint } from '../fakes/fake-adapter';
import { fc } from '../helpers/fast-check';
import type {
  CapabilityDescriptor,
  ResumeClassification,
  TaskState,
  TaskStepStatus,
} from '@shared/domain';

// Property 2 — Deterministic recovery (Validates: Requirements 8.2, 8.3).
// Property 4 — Idempotent resume (Validates: Requirement 8.5).
//
// 8.2 / 8.3 / Property 2: for a crash at ANY point, onBoot() reconstructs each
//   non-terminal task into EXACTLY ONE of {resumable prior state,
//   RECOVERABLE_INTERRUPTION, BLOCKED}, and a second onBoot() over unchanged
//   persisted + liveness + filesystem inputs yields the SAME classification
//   (the reconciliation is deterministic and idempotent).
//
// 8.5 / Property 4: resuming a task NEVER re-executes a step already marked
//   `succeeded`.
//
// Both halves drive the REAL orchestrator machinery (the write-ahead
// TaskStateMachine, StepExecutor, TaskCanceller, ResumeCenter, ResumeService)
// against a FakeAdapter, injecting crash points by (a) crashing the adapter at
// a random lifecycle phase during runSteps and/or (b) reconciling against a
// random session-liveness + filesystem-drift world. No Electron, no real clock.
//
// Each property iteration builds a COMPLETELY FRESH persistence world (its own
// in-memory SQLite store, workspace, blob root, and registry) so no state from
// one generated case ever leaks into the next — a shared store would collide
// agent_session ids across iterations and make a clean run look like a failure.

const CLASSIFICATIONS: readonly ResumeClassification[] = [
  'RESUMABLE',
  'RECOVERABLE_INTERRUPTION',
  'BLOCKED',
];

/** Everything one property iteration needs, wired against one fresh store. */
interface World {
  store: SqliteStore;
  audit: AuditLog;
  workspaces: WorkspaceService;
  permissions: PermissionService;
  stateMachine: TaskStateMachine;
  workspaceId: string;
  tmpRoot: string;
  blobRoot: string;
  dispose(): void;
}

/** Build a fresh, fully-migrated world with one workspace. */
async function freshWorld(): Promise<World> {
  const store = new SqliteStore(':memory:');
  await store.migrate();
  const audit = new AuditLog(store);
  const workspaces = new WorkspaceService(store);
  const permissions = new PermissionService(store, audit);
  const stateMachine = new TaskStateMachine(store, audit);
  const tmpRoot = mkdtempSync(join(tmpdir(), 'conductor-ws-'));
  const blobRoot = mkdtempSync(join(tmpdir(), 'conductor-blob-'));
  const workspaceId = workspaces.create({ name: 'WS', rootPath: tmpRoot }).id;
  return {
    store,
    audit,
    workspaces,
    permissions,
    stateMachine,
    workspaceId,
    tmpRoot,
    blobRoot,
    dispose() {
      store.close();
      rmSync(tmpRoot, { recursive: true, force: true });
      rmSync(blobRoot, { recursive: true, force: true });
    },
  };
}

/** A multi-step planner producing a linear chain of `n` steps. */
function chainPlanner(n: number): Planner {
  return {
    decompose(): Promise<PlanDecomposition> {
      return Promise.resolve({
        steps: Array.from({ length: n }, (_v, i) => ({
          id: `step-${i + 1}`,
          description: `step ${i + 1}`,
          requiredCapability: PLACEHOLDER_PLAN_CAPABILITY,
          ...(i > 0 ? { dependsOn: [`step-${i}`] } : {}),
        })),
      });
    },
  };
}

const PLAN_CAPABILITY: CapabilityDescriptor = {
  id: PLACEHOLDER_PLAN_CAPABILITY,
  title: 'Fulfill objective (fake)',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  streaming: true,
  cancellable: true,
  resumable: false,
  requiredPermissions: [],
};

/**
 * A registry with a single adapter declaring the plan capability. `onStart`,
 * when given, is invoked with each `start` input so a test can count/record
 * which steps the adapter was actually asked to run.
 */
function registryWith(opts: {
  crashAt?: FakeCrashPoint;
  livenessDefault?: boolean;
  onStart?: (input: unknown) => void;
}): Registry {
  const adapter = makeFakeAdapter({
    record: {
      id: 'planner-fake',
      name: 'Planner Fake',
      capabilities: [PLAN_CAPABILITY],
    },
    script: {
      result: { status: 'succeeded', exitCode: 0 },
      livenessDefault: opts.livenessDefault ?? false,
      ...(opts.crashAt !== undefined ? { crashAt: opts.crashAt } : {}),
    },
  });
  if (opts.onStart !== undefined) {
    const record = opts.onStart;
    const originalStart = adapter.start.bind(adapter);
    adapter.start = async (input: unknown) => {
      record(input);
      return originalStart(input);
    };
  }
  const reg = new Registry();
  reg.register(adapter);
  return reg;
}

/** A backoff clock that resolves immediately so retries never wall-clock wait. */
const immediateBackoffClock = { sleep: (): Promise<void> => Promise.resolve() };

function makeOrchestrator(
  world: World,
  registry: Registry,
  planner: Planner,
): { orchestrator: Orchestrator; canceller: TaskCanceller } {
  const canceller = new TaskCanceller(
    world.store,
    world.stateMachine,
    registry,
    world.audit,
  );
  const orchestrator = new Orchestrator(
    world.store,
    world.stateMachine,
    world.workspaces,
    canceller,
    world.audit,
    {
      registry,
      permissions: world.permissions,
      planner,
      // Inject an immediate backoff so the bounded step retries triggered by an
      // injected crash never sleep on the real wall clock (keeps the PBT fast).
      backoffClock: immediateBackoffClock,
    },
  );
  return { orchestrator, canceller };
}

function taskState(world: World, taskId: string): TaskState {
  return (
    world.store.db
      .prepare('SELECT state FROM tasks WHERE id = ?')
      .get(taskId) as { state: TaskState }
  ).state;
}

function stepStatuses(world: World, taskId: string): TaskStepStatus[] {
  const rows = world.store.db
    .prepare('SELECT status FROM task_steps WHERE task_id = ? ORDER BY ordinal ASC')
    .all(taskId) as { status: TaskStepStatus }[];
  return rows.map((r) => r.status);
}

function stepIdsOf(world: World, taskId: string): string[] {
  return (
    world.store.db
      .prepare('SELECT id FROM task_steps WHERE task_id = ? ORDER BY ordinal ASC')
      .all(taskId) as { id: string }[]
  ).map((r) => r.id);
}

function classificationMap(snapshot: {
  items: { taskId: string; classification: ResumeClassification }[];
}): Map<string, ResumeClassification> {
  return new Map(snapshot.items.map((i) => [i.taskId, i.classification]));
}

describe('P2 — deterministic recovery (Requirements 8.2, 8.3)', () => {
  it('classifies every non-terminal task into exactly one class, deterministically across two onBoot runs, for a crash at any point', async () => {
    await fc.assert(
      fc.asyncProperty(
        // A crash injected at a random adapter lifecycle phase while the task's
        // step is executing — this stands in for a "crash at any point".
        fc.constantFrom<FakeCrashPoint>('start', 'stream', 'await'),
        // Whether the task's leftover session probes as live on reboot.
        fc.boolean(),
        // Whether a referenced artifact blob went missing (filesystem drift).
        fc.boolean(),
        async (crashAt, livenessOnBoot, injectDrift) => {
          const world = await freshWorld();
          try {
            // 1. Build and run a task until the injected crash interrupts it.
            const runReg = registryWith({ crashAt, livenessDefault: false });
            const { orchestrator } = makeOrchestrator(
              world,
              runReg,
              chainPlanner(1),
            );
            const created = await orchestrator.createTask({
              workspaceId: world.workspaceId,
              objective: 'do the thing',
            });
            await orchestrator.beginExecution(created.id);

            // runSteps drives PLANNING → RUNNING and hits the crash; the step
            // exhausts retries and the task lands in VERIFYING (failed path),
            // leaving a persisted, non-terminal task to reconcile on reboot.
            await orchestrator.runSteps(created.id);

            // Optionally reference a blob that is absent → filesystem drift.
            if (injectDrift) {
              const now = new Date().toISOString();
              world.store.db
                .prepare(
                  `INSERT INTO checkpoints (id, task_id, step_id, state, snapshot, verified, created_at)
                   VALUES (?, ?, NULL, 'RUNNING', '{}', 0, ?)`,
                )
                .run(randomUUID(), created.id, now);
              const cpTime = (
                world.store.db
                  .prepare(
                    `SELECT created_at FROM checkpoints WHERE task_id = ?
                     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
                  )
                  .get(created.id) as { created_at: string }
              ).created_at;
              world.store.db
                .prepare(
                  `INSERT INTO task_events (id, task_id, step_id, kind, payload, created_at)
                   VALUES (?, ?, NULL, 'artifact', ?, ?)`,
                )
                .run(
                  randomUUID(),
                  created.id,
                  JSON.stringify({ artifactId: randomUUID() }),
                  cpTime,
                );
            }

            const beforeState = taskState(world, created.id);
            const terminal =
              beforeState === 'COMPLETED' ||
              beforeState === 'FAILED' ||
              beforeState === 'CANCELLED';

            // 2. Reboot: a fresh ResumeCenter reconciles against a reality where
            //    the leftover session probes live/dead as scripted and drift is
            //    present or not. The SAME inputs must classify identically twice.
            const bootReg = registryWith({ livenessDefault: livenessOnBoot });
            const storage = new DiskManagedStorage(world.blobRoot);
            const rc = new ResumeCenter(
              world.store,
              world.stateMachine,
              bootReg,
              world.audit,
              { storage },
            );

            const first = await rc.onBoot();
            const firstMap = classificationMap(first);

            // Every reconciled item has exactly one valid classification.
            for (const item of first.items) {
              expect(CLASSIFICATIONS).toContain(item.classification);
            }

            // The task appears and is classified iff it is non-terminal.
            if (!terminal) {
              expect(firstMap.has(created.id)).toBe(true);
              expect(CLASSIFICATIONS).toContain(firstMap.get(created.id));
            }

            // 3. A second onBoot over the now-reconciled (input-equivalent)
            //    world yields the identical classification for every task.
            const second = await rc.onBoot();
            const secondMap = classificationMap(second);
            expect([...secondMap.entries()].sort()).toEqual(
              [...firstMap.entries()].sort(),
            );
          } finally {
            world.dispose();
          }
        },
      ),
      { numRuns: 50 },
    );
  }, 60_000);
});

describe('P4 — idempotent resume (Requirement 8.5)', () => {
  it('never re-executes a step already marked succeeded, for any prefix of pre-succeeded steps', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Total steps in the plan (a linear chain).
        fc.integer({ min: 1, max: 5 }),
        // How many leading steps were already `succeeded` before the crash.
        fc.integer({ min: 0, max: 5 }),
        async (totalSteps, rawSucceededPrefix) => {
          const succeededPrefix = Math.min(rawSucceededPrefix, totalSteps);
          const world = await freshWorld();
          try {
            const started: unknown[] = [];
            const registry = registryWith({
              onStart: (input) => started.push(input),
            });
            const { orchestrator, canceller } = makeOrchestrator(
              world,
              registry,
              chainPlanner(totalSteps),
            );
            const resume = new ResumeService(
              world.store,
              world.stateMachine,
              orchestrator,
              canceller,
              world.audit,
            );

            const created = await orchestrator.createTask({
              workspaceId: world.workspaceId,
              objective: 'resume me',
            });
            await orchestrator.beginExecution(created.id); // → PLANNING, DAG persisted

            // Simulate a crash after the first `succeededPrefix` steps ran: mark
            // those succeeded, then reconcile to RECOVERABLE_INTERRUPTION exactly
            // as onBoot would for a mid-flight task with no live session.
            const stepIds = stepIdsOf(world, created.id);
            for (const id of stepIds.slice(0, succeededPrefix)) {
              world.store.db
                .prepare(`UPDATE task_steps SET status = 'succeeded' WHERE id = ?`)
                .run(id);
            }
            world.stateMachine.transition({
              taskId: created.id,
              to: 'RECOVERABLE_INTERRUPTION',
              eventPayload: { reason: 'boot-reconcile' },
            });

            // Resume (no consequential permissions → no confirmation needed).
            const result = await resume.act({
              taskId: created.id,
              action: 'resume',
            });

            // Idempotent resume: the adapter was started EXACTLY once per step
            // that was still pending — never for an already-succeeded step.
            expect(result.status).toBe('applied');
            expect(started.length).toBe(totalSteps - succeededPrefix);

            // Every pre-succeeded step is still `succeeded` (not reset, not
            // re-run); the whole chain ends succeeded (resume ran the rest).
            const finalStatuses = stepStatuses(world, created.id);
            finalStatuses.slice(0, succeededPrefix).forEach((status) => {
              expect(status).toBe('succeeded');
            });
            expect(finalStatuses).toEqual(
              Array.from({ length: totalSteps }, () => 'succeeded'),
            );
            // Steps done → VERIFYING.
            expect(result.state).toBe('VERIFYING');
            expect(taskState(world, created.id)).toBe('VERIFYING');
          } finally {
            world.dispose();
          }
        },
      ),
      { numRuns: 50 },
    );
  }, 60_000);

  it('a resume after a full run re-runs no step, since every step is already succeeded', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 4 }), async (totalSteps) => {
        const world = await freshWorld();
        try {
          const started: unknown[] = [];
          const registry = registryWith({
            onStart: (input) => started.push(input),
          });
          const { orchestrator, canceller } = makeOrchestrator(
            world,
            registry,
            chainPlanner(totalSteps),
          );
          const resume = new ResumeService(
            world.store,
            world.stateMachine,
            orchestrator,
            canceller,
            world.audit,
          );

          const created = await orchestrator.createTask({
            workspaceId: world.workspaceId,
            objective: 'resume twice',
          });
          await orchestrator.beginExecution(created.id);

          // First full run: every step succeeds, task reaches VERIFYING.
          await orchestrator.runSteps(created.id);
          expect(stepStatuses(world, created.id)).toEqual(
            Array.from({ length: totalSteps }, () => 'succeeded'),
          );
          const startsAfterFirstRun = started.length;
          expect(startsAfterFirstRun).toBe(totalSteps);

          // Reconcile as if a crash interrupted VERIFYING, then resume: since
          // every step is already succeeded, the adapter must not start again.
          world.stateMachine.transition({
            taskId: created.id,
            to: 'RECOVERABLE_INTERRUPTION',
            eventPayload: { reason: 'boot-reconcile' },
          });
          const result = await resume.act({
            taskId: created.id,
            action: 'resume',
          });

          expect(result.status).toBe('applied');
          // No additional starts — idempotent resume skipped all succeeded steps.
          expect(started.length).toBe(startsAfterFirstRun);
          expect(result.state).toBe('VERIFYING');
        } finally {
          world.dispose();
        }
      }),
      { numRuns: 40 },
    );
  }, 60_000);
});
