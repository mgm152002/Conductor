// Integration tests for Orchestrator.planTask — planning into a routed,
// persisted intra-task DAG (task 9.2, Requirements 5.4, 5.5, 5.6, 5.8).
//
// These drive the orchestrator through a pluggable, deterministic planner so we
// can assert:
//   * a routable acyclic plan is decomposed, topologically ordered, routed, and
//     persisted to task_steps with assigned adapters and resolved dependencies
//     (5.4, 5.5);
//   * a cyclic decomposition is rejected — nothing persisted, no step executed,
//     error naming the cycle (5.8);
//   * an unroutable step rejects the whole plan — nothing persisted, no step
//     executed, error naming the step (5.6);
//   * a deterministic fallback routes a step that no adapter can serve (5.5).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '@main/db/store';
import { AuditLog } from '@main/domain/audit-log';
import { PermissionService } from '@main/domain/permission-service';
import { Registry } from '@main/registry/registry';
import { WorkspaceService } from '@main/domain/workspace-service';
import { TaskStateMachine } from '@main/orchestrator/state-machine';
import { TaskCanceller } from '@main/orchestrator/cancellation';
import {
  Orchestrator,
  PlanRoutingError,
} from '@main/orchestrator/orchestrator';
import {
  PlanCycleError,
  type PlanDecomposition,
  type Planner,
} from '@main/orchestrator/planner';
import { makeFakeAdapter } from '../fakes/fake-adapter';
import type { CapabilityDescriptor, TaskState } from '@shared/domain';

let store: SqliteStore;
let audit: AuditLog;
let workspaces: WorkspaceService;
let stateMachine: TaskStateMachine;
let canceller: TaskCanceller;
let registry: Registry;
let permissions: PermissionService;
let tmpRoot: string;
let workspaceId: string;

/** A planner that returns a fixed decomposition, for deterministic tests. */
class FixedPlanner implements Planner {
  constructor(private readonly decomposition: PlanDecomposition) {}
  decompose(): Promise<PlanDecomposition> {
    return Promise.resolve(this.decomposition);
  }
}

function cap(id: string): CapabilityDescriptor {
  return {
    id,
    title: id,
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    streaming: false,
    cancellable: true,
    resumable: false,
    requiredPermissions: [],
  };
}

function registerAdapter(id: string, capabilityId: string): void {
  registry.register(
    makeFakeAdapter({
      record: { id, name: id, capabilities: [cap(capabilityId)] },
    }),
  );
}

/** Build an orchestrator with a specific injected planner. */
function orchestratorWith(planner: Planner): Orchestrator {
  return new Orchestrator(store, stateMachine, workspaces, canceller, audit, {
    planner,
    registry,
    permissions,
  });
}

interface StepRow {
  id: string;
  ordinal: number;
  description: string;
  depends_on: string;
  assigned_adapter_id: string | null;
  status: string;
}

function stepRows(taskId: string): StepRow[] {
  return store.db
    .prepare(
      `SELECT id, ordinal, description, depends_on, assigned_adapter_id, status
       FROM task_steps WHERE task_id = ? ORDER BY ordinal ASC`,
    )
    .all(taskId) as StepRow[];
}

function stepCount(taskId: string): number {
  return (
    store.db
      .prepare('SELECT COUNT(*) AS n FROM task_steps WHERE task_id = ?')
      .get(taskId) as { n: number }
  ).n;
}

function taskState(taskId: string): TaskState {
  return (
    store.db.prepare('SELECT state FROM tasks WHERE id = ?').get(taskId) as {
      state: TaskState;
    }
  ).state;
}

/** Create a task and advance it to PLANNING so planTask can run. */
async function createPlanningTask(
  orch: Orchestrator,
  objective = 'objective',
): Promise<string> {
  const task = await orch.createTask({ workspaceId, objective });
  stateMachine.transition({ taskId: task.id, to: 'CONTEXT_LOADING' });
  stateMachine.transition({ taskId: task.id, to: 'PLANNING' });
  return task.id;
}

beforeEach(async () => {
  store = new SqliteStore(':memory:');
  await store.migrate();
  audit = new AuditLog(store);
  workspaces = new WorkspaceService(store);
  stateMachine = new TaskStateMachine(store, audit);
  registry = new Registry();
  permissions = new PermissionService(store, audit);
  canceller = new TaskCanceller(store, stateMachine, registry, audit);

  tmpRoot = mkdtempSync(join(tmpdir(), 'conductor-plan-'));
  workspaceId = workspaces.create({ name: 'WS', rootPath: tmpRoot }).id;
});

afterEach(() => {
  store.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('planTask — routable acyclic DAG (Requirements 5.4, 5.5)', () => {
  it('decomposes, topologically orders, routes, and persists the steps', async () => {
    registerAdapter('reader', 'read');
    registerAdapter('writer', 'write');

    const orch = orchestratorWith(
      new FixedPlanner({
        steps: [
          { id: 'w', description: 'write', requiredCapability: 'write', dependsOn: ['r'] },
          { id: 'r', description: 'read', requiredCapability: 'read' },
        ],
      }),
    );
    const taskId = await createPlanningTask(orch);

    const state = await orch.planTask(taskId);

    // Planning stops at PLANNING once the plan is persisted (RUNNING is 9.3).
    expect(state).toBe('PLANNING');
    expect(taskState(taskId)).toBe('PLANNING');

    const rows = stepRows(taskId);
    expect(rows).toHaveLength(2);

    // Topological order: the read step precedes the write step it feeds.
    const [first, second] = rows;
    expect(first?.description).toBe('read');
    expect(first?.ordinal).toBe(0);
    expect(second?.description).toBe('write');
    expect(second?.ordinal).toBe(1);

    // Each step was routed to the adapter declaring its capability (no user
    // agent selection).
    expect(first?.assigned_adapter_id).toBe('reader');
    expect(second?.assigned_adapter_id).toBe('writer');

    // depends_on references the DURABLE id of the dependency, not the planner id.
    const deps = JSON.parse(second?.depends_on ?? '[]') as string[];
    expect(deps).toEqual([first?.id]);

    // All steps start pending; nothing is executed by planning.
    expect(rows.every((r) => r.status === 'pending')).toBe(true);
  });

  it('routes a step with no adapter via a deterministic fallback automation', async () => {
    // One capability has an adapter; the other only a fallback automation.
    registerAdapter('reader', 'read');

    const orch = new Orchestrator(
      store,
      stateMachine,
      workspaces,
      canceller,
      audit,
      {
        planner: new FixedPlanner({
          steps: [
            { id: 'r', description: 'read', requiredCapability: 'read' },
            { id: 'f', description: 'format', requiredCapability: 'format' },
          ],
        }),
        registry,
        permissions,
        fallbackAutomations: new Map([['format', 'builtin-format']]),
      },
    );
    const taskId = await createPlanningTask(orch);

    const state = await orch.planTask(taskId);
    expect(state).toBe('PLANNING');

    const rows = stepRows(taskId);
    expect(rows).toHaveLength(2);
    const fallbackStep = rows.find((r) => r.description === 'format');
    // A fallback step has no assigned adapter but is persisted (routable).
    expect(fallbackStep?.assigned_adapter_id).toBeNull();
  });
});

describe('planTask — cyclic graph rejection (Requirement 5.8)', () => {
  it('rejects a cyclic plan, persists nothing, and names the cycle', async () => {
    registerAdapter('any', 'cap');

    const orch = orchestratorWith(
      new FixedPlanner({
        steps: [
          { id: 'a', description: 'a', requiredCapability: 'cap', dependsOn: ['b'] },
          { id: 'b', description: 'b', requiredCapability: 'cap', dependsOn: ['a'] },
        ],
      }),
    );
    const taskId = await createPlanningTask(orch);

    await expect(orch.planTask(taskId)).rejects.toBeInstanceOf(PlanCycleError);

    // No step executed/persisted; the task stays in PLANNING.
    expect(stepCount(taskId)).toBe(0);
    expect(taskState(taskId)).toBe('PLANNING');
  });

  it('runs the cycle check before routing (cycle wins even if unroutable)', async () => {
    // No adapters registered: a cyclic plan would also be unroutable, but the
    // cycle is detected first (before anything is routed), so the error is the
    // cycle error, not the routing error.
    const orch = orchestratorWith(
      new FixedPlanner({
        steps: [
          { id: 'a', description: 'a', requiredCapability: 'x', dependsOn: ['b'] },
          { id: 'b', description: 'b', requiredCapability: 'x', dependsOn: ['a'] },
        ],
      }),
    );
    const taskId = await createPlanningTask(orch);

    await expect(orch.planTask(taskId)).rejects.toBeInstanceOf(PlanCycleError);
    expect(stepCount(taskId)).toBe(0);
  });
});

describe('planTask — unroutable step rejection (Requirement 5.6)', () => {
  it('rejects the plan naming the unroutable step and persists nothing', async () => {
    // Only "read" has an adapter; "missing" has neither adapter nor fallback.
    registerAdapter('reader', 'read');

    const orch = orchestratorWith(
      new FixedPlanner({
        steps: [
          { id: 'r', description: 'read', requiredCapability: 'read' },
          { id: 'm', description: 'missing', requiredCapability: 'missing' },
        ],
      }),
    );
    const taskId = await createPlanningTask(orch);

    try {
      await orch.planTask(taskId);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanRoutingError);
      // The error names exactly the unroutable step (by planner-local id).
      expect((err as PlanRoutingError).stepIds).toEqual(['m']);
    }

    // No step executed/persisted — not even the routable "read" step.
    expect(stepCount(taskId)).toBe(0);
    expect(taskState(taskId)).toBe('PLANNING');
  });

  it('rejects when the only step is unroutable', async () => {
    const orch = orchestratorWith(
      new FixedPlanner({
        steps: [{ id: 'solo', description: 'solo', requiredCapability: 'nope' }],
      }),
    );
    const taskId = await createPlanningTask(orch);

    await expect(orch.planTask(taskId)).rejects.toBeInstanceOf(
      PlanRoutingError,
    );
    expect(stepCount(taskId)).toBe(0);
  });
});
