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
import {
  VERIFICATION_TIMEOUT_MS,
  type CriterionEvaluator,
  type VerificationClock,
} from '@main/orchestrator/verifier';
import { makeFakeAdapter } from '../fakes/fake-adapter';
import type { CapabilityDescriptor } from '@shared/adapter';
import type { TaskState } from '@shared/domain';

// Task 9.4 — VERIFYING with no-false-completion and verification timeout. These
// tests drive Orchestrator.verifyTask against a task that reached VERIFYING via
// the real RUNNING execution path (runSteps), with the per-criterion evaluator
// and the 300s timeout clock injected so the pass is exercised deterministically
// without Electron or real wall-clock time.

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

interface BuildOptions {
  evaluator?: CriterionEvaluator;
  verificationClock?: VerificationClock;
  verificationTimeoutMs?: number;
}

function buildOrchestrator(opts: BuildOptions = {}): Orchestrator {
  const registry = routableRegistry();
  const canceller = new TaskCanceller(store, stateMachine, registry, audit);
  return new Orchestrator(store, stateMachine, workspaces, canceller, audit, {
    registry,
    permissions,
    ...(opts.evaluator !== undefined ? { criterionEvaluator: opts.evaluator } : {}),
    ...(opts.verificationClock !== undefined
      ? { verificationClock: opts.verificationClock }
      : {}),
    ...(opts.verificationTimeoutMs !== undefined
      ? { verificationTimeoutMs: opts.verificationTimeoutMs }
      : {}),
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

/** A monotonic clock that returns the values it is seeded with, in order. */
function scriptedClock(values: number[]): VerificationClock {
  let i = 0;
  return {
    now(): number {
      const v = values[Math.min(i, values.length - 1)]!;
      i += 1;
      return v;
    },
  };
}

beforeEach(async () => {
  store = new SqliteStore(':memory:');
  await store.migrate();
  audit = new AuditLog(store);
  workspaces = new WorkspaceService(store);
  stateMachine = new TaskStateMachine(store, audit);
  permissions = new PermissionService(store, audit);
  tmpRoot = mkdtempSync(join(tmpdir(), 'conductor-ws-'));
  workspaceId = workspaces.create({ name: 'WS', rootPath: tmpRoot }).id;
});

afterEach(() => {
  store.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('Orchestrator.verifyTask — completion requires every criterion', () => {
  it('transitions VERIFYING → COMPLETED with a verified checkpoint when all criteria pass', async () => {
    const evaluator: CriterionEvaluator = () => true;
    const orchestrator = buildOrchestrator({ evaluator });
    const taskId = await createVerifying(orchestrator, ['a passes', 'b passes']);

    const result = await orchestrator.verifyTask(taskId);

    expect(result.outcome).toBe('completed');
    expect(result.state).toBe('COMPLETED');
    expect(taskState(taskId)).toBe('COMPLETED');
    expect(result.criteria).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
    expect(result.verifiedCheckpointId).toBeDefined();

    // The verified checkpoint exists, is flagged verified, and the task points
    // at it (Requirement 7.6).
    const cp = store.db
      .prepare('SELECT verified FROM checkpoints WHERE id = ?')
      .get(result.verifiedCheckpointId!) as { verified: number };
    expect(cp.verified).toBe(1);
    const task = orchestrator.getTask(taskId);
    expect(task?.lastVerifiedCheckpointId).toBe(result.verifiedCheckpointId);
  });

  it('transitions VERIFYING → FAILED recording which criteria failed when any criterion fails', async () => {
    // First criterion passes, second fails.
    const evaluator: CriterionEvaluator = ({ index }) => index === 0;
    const orchestrator = buildOrchestrator({ evaluator });
    const taskId = await createVerifying(orchestrator, ['pass', 'fail']);

    const result = await orchestrator.verifyTask(taskId);

    expect(result.outcome).toBe('failed');
    expect(result.state).toBe('FAILED');
    expect(taskState(taskId)).toBe('FAILED');
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.index).toBe(1);
    expect(result.failed[0]?.criterion).toBe('fail');

    // No verified checkpoint was written for a failed verification.
    expect(result.verifiedCheckpointId).toBeUndefined();
    const task = orchestrator.getTask(taskId);
    expect(task?.lastVerifiedCheckpointId).toBeUndefined();
  });

  it('never completes on exit-code-0 alone: the default evaluator fails every criterion', async () => {
    // No evaluator injected → conservative default fails every criterion even
    // though the adapter exited 0 (Property 3; Requirement 7.3).
    const orchestrator = buildOrchestrator();
    const taskId = await createVerifying(orchestrator, ['must be verified']);

    const result = await orchestrator.verifyTask(taskId);

    expect(result.outcome).toBe('failed');
    expect(taskState(taskId)).toBe('FAILED');
    expect(result.failed).toHaveLength(1);
  });
});

describe('Orchestrator.verifyTask — verification timeout (Requirement 7.5)', () => {
  it('transitions VERIFYING → RECOVERABLE_INTERRUPTION when the pass exceeds 300s', async () => {
    // Clock: start at 0, then the pre-first-criterion check reads a value past
    // the 300s budget so the pass times out before recording any outcome.
    const clock = scriptedClock([0, VERIFICATION_TIMEOUT_MS + 1]);
    const evaluator: CriterionEvaluator = () => true;
    const orchestrator = buildOrchestrator({ evaluator, verificationClock: clock });
    const taskId = await createVerifying(orchestrator, ['slow criterion']);

    const result = await orchestrator.verifyTask(taskId);

    expect(result.outcome).toBe('timed_out');
    expect(result.state).toBe('RECOVERABLE_INTERRUPTION');
    expect(taskState(taskId)).toBe('RECOVERABLE_INTERRUPTION');

    // The timeout is recorded with verification-did-not-finish provenance.
    const ev = store.db
      .prepare(
        `SELECT payload FROM task_events
         WHERE task_id = ? AND kind = 'transition'
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get(taskId) as { payload: string };
    const payload = JSON.parse(ev.payload) as {
      reason: string;
      verificationFinished: boolean;
    };
    expect(payload.reason).toBe('verification-timeout');
    expect(payload.verificationFinished).toBe(false);
  });

  it('does not time out when every criterion resolves within the budget', async () => {
    // Clock stays well under the budget across all reads.
    const clock = scriptedClock([0, 10, 20, 30, 40]);
    const evaluator: CriterionEvaluator = () => true;
    const orchestrator = buildOrchestrator({ evaluator, verificationClock: clock });
    const taskId = await createVerifying(orchestrator, ['fast criterion']);

    const result = await orchestrator.verifyTask(taskId);

    expect(result.outcome).toBe('completed');
    expect(taskState(taskId)).toBe('COMPLETED');
  });
});

describe('Orchestrator.verifyTask — criterion outcomes and detail', () => {
  it('records per-criterion pass/fail outcomes produced by the evaluator', async () => {
    const evaluator: CriterionEvaluator = ({ criterion, index }) => ({
      criterion,
      index,
      satisfied: index % 2 === 0,
      detail: `evaluated ${criterion}`,
    });
    const orchestrator = buildOrchestrator({ evaluator });
    const taskId = await createVerifying(orchestrator, ['c0', 'c1', 'c2']);

    const result = await orchestrator.verifyTask(taskId);

    expect(result.outcome).toBe('failed');
    expect(result.criteria).toHaveLength(3);
    expect(result.criteria.map((c) => c.satisfied)).toEqual([true, false, true]);
    expect(result.failed.map((c) => c.index)).toEqual([1]);
    expect(result.criteria[0]?.detail).toBe('evaluated c0');
  });

  it('supports an async evaluator', async () => {
    const evaluator: CriterionEvaluator = async () => {
      await Promise.resolve();
      return true;
    };
    const orchestrator = buildOrchestrator({ evaluator });
    const taskId = await createVerifying(orchestrator, ['async pass']);

    const result = await orchestrator.verifyTask(taskId);
    expect(result.outcome).toBe('completed');
  });
});

describe('Orchestrator.verifyTask — vacuous and guard cases', () => {
  it('completes a task with zero acceptance criteria (nothing to fail)', async () => {
    const orchestrator = buildOrchestrator();
    const taskId = await createVerifying(orchestrator, []);

    const result = await orchestrator.verifyTask(taskId);

    expect(result.outcome).toBe('completed');
    expect(result.criteria).toHaveLength(0);
    expect(result.verifiedCheckpointId).toBeDefined();
  });

  it('is a no-op on a task that is not in VERIFYING', async () => {
    const orchestrator = buildOrchestrator();
    const task = await orchestrator.createTask({
      workspaceId,
      objective: 'not yet verifying',
    });

    const result = await orchestrator.verifyTask(task.id);

    expect(result.outcome).toBe('not_verifying');
    expect(result.state).toBe('CREATED');
    expect(taskState(task.id)).toBe('CREATED');
  });

  it('reports already_terminal for a cancelled task', async () => {
    const orchestrator = buildOrchestrator();
    const task = await orchestrator.createTask({
      workspaceId,
      objective: 'to be cancelled',
    });
    await orchestrator.cancelTask(task.id);

    const result = await orchestrator.verifyTask(task.id);
    expect(result.outcome).toBe('already_terminal');
    expect(result.state).toBe('CANCELLED');
  });

  it('throws when the task does not exist', async () => {
    const orchestrator = buildOrchestrator();
    await expect(orchestrator.verifyTask('missing')).rejects.toThrow(/not found/);
  });
});
