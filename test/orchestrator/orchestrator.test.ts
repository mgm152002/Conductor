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
import {
  MAX_OBJECTIVE_LENGTH,
  Orchestrator,
  TaskValidationError,
} from '@main/orchestrator/orchestrator';
import { PLACEHOLDER_PLAN_CAPABILITY } from '@main/orchestrator/planner';
import type { ContextProvider } from '@main/orchestrator/context-provider';
import { makeFakeAdapter } from '../fakes/fake-adapter';
import type { Task, TaskEvent, TaskState } from '@shared/domain';

let store: SqliteStore;
let audit: AuditLog;
let workspaces: WorkspaceService;
let stateMachine: TaskStateMachine;
let canceller: TaskCanceller;
let registry: Registry;
let permissions: PermissionService;
let orchestrator: Orchestrator;
let tmpRoot: string;
let workspaceId: string;

/**
 * A registry whose single adapter declares the placeholder planner's capability
 * so planning can route the one-step plan `beginExecution` produces. Without a
 * routable adapter every step is unroutable and planning rejects the plan.
 */
function routableRegistry(): Registry {
  const reg = new Registry();
  reg.register(
    makeFakeAdapter({
      record: {
        id: 'planner-fake',
        name: 'Planner Fake',
        capabilities: [
          {
            id: PLACEHOLDER_PLAN_CAPABILITY,
            title: 'Fulfill objective (fake)',
            inputSchema: { type: 'object' },
            outputSchema: { type: 'object' },
            streaming: false,
            cancellable: true,
            resumable: false,
            requiredPermissions: [],
          },
        ],
      },
    }),
  );
  return reg;
}

beforeEach(async () => {
  store = new SqliteStore(':memory:');
  await store.migrate();

  audit = new AuditLog(store);
  workspaces = new WorkspaceService(store);
  stateMachine = new TaskStateMachine(store, audit);
  registry = routableRegistry();
  permissions = new PermissionService(store, audit);
  canceller = new TaskCanceller(store, stateMachine, registry, audit);
  orchestrator = new Orchestrator(
    store,
    stateMachine,
    workspaces,
    canceller,
    audit,
    { registry, permissions },
  );

  // WorkspaceService canonicalizes rootPath to an existing directory, so use a
  // real temp dir.
  tmpRoot = mkdtempSync(join(tmpdir(), 'conductor-ws-'));
  workspaceId = workspaces.create({ name: 'WS', rootPath: tmpRoot }).id;
});

afterEach(() => {
  store.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function taskRow(taskId: string): { state: TaskState; context_refs: string } {
  return store.db
    .prepare('SELECT state, context_refs FROM tasks WHERE id = ?')
    .get(taskId) as { state: TaskState; context_refs: string };
}

function taskEvents(taskId: string): TaskEvent[] {
  const rows = store.db
    .prepare(
      `SELECT id, task_id, step_id, kind, payload, created_at
       FROM task_events WHERE task_id = ? ORDER BY created_at ASC, rowid ASC`,
    )
    .all(taskId) as {
    id: string;
    task_id: string;
    step_id: string | null;
    kind: TaskEvent['kind'];
    payload: string;
    created_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    ...(r.step_id !== null ? { stepId: r.step_id } : {}),
    kind: r.kind,
    payload: JSON.parse(r.payload) as unknown,
    createdAt: r.created_at,
  }));
}

function countTasks(): number {
  return (
    store.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }
  ).n;
}

describe('Orchestrator.createTask', () => {
  it('persists a task in CREATED with a transition event and no other side effects', async () => {
    const task = await orchestrator.createTask({
      workspaceId,
      objective: 'summarize the repo',
    });

    expect(task.state).toBe('CREATED');
    expect(task.workspaceId).toBe(workspaceId);
    expect(task.objective).toBe('summarize the repo');
    expect(task.contextRefs).toEqual([]);

    expect(taskRow(task.id).state).toBe('CREATED');

    // Exactly one event — the opening transition — and no steps/sessions.
    const events = taskEvents(task.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('transition');
    expect(events[0]?.payload).toMatchObject({ to: 'CREATED' });

    const stepCount = (
      store.db
        .prepare('SELECT COUNT(*) AS n FROM task_steps WHERE task_id = ?')
        .get(task.id) as { n: number }
    ).n;
    const sessionCount = (
      store.db
        .prepare('SELECT COUNT(*) AS n FROM agent_sessions WHERE task_id = ?')
        .get(task.id) as { n: number }
    ).n;
    expect(stepCount).toBe(0);
    expect(sessionCount).toBe(0);

    // An opening checkpoint in CREATED was committed alongside the task.
    const checkpointCount = (
      store.db
        .prepare('SELECT COUNT(*) AS n FROM checkpoints WHERE task_id = ?')
        .get(task.id) as { n: number }
    ).n;
    expect(checkpointCount).toBe(1);
  });

  it('trims the objective before persisting', async () => {
    const task = await orchestrator.createTask({
      workspaceId,
      objective: '   padded objective   ',
    });
    expect(task.objective).toBe('padded objective');
  });

  it('rejects an empty objective with a field-specific error and creates no task', async () => {
    await expect(
      orchestrator.createTask({ workspaceId, objective: '   ' }),
    ).rejects.toMatchObject({
      name: 'TaskValidationError',
      field: 'objective',
    });
    expect(countTasks()).toBe(0);
  });

  it('rejects an objective over 10,000 characters and creates no task', async () => {
    const tooLong = 'x'.repeat(MAX_OBJECTIVE_LENGTH + 1);
    await expect(
      orchestrator.createTask({ workspaceId, objective: tooLong }),
    ).rejects.toBeInstanceOf(TaskValidationError);
    expect(countTasks()).toBe(0);
  });

  it('accepts an objective of exactly 10,000 characters', async () => {
    const exact = 'y'.repeat(MAX_OBJECTIVE_LENGTH);
    const task = await orchestrator.createTask({
      workspaceId,
      objective: exact,
    });
    expect(task.objective).toHaveLength(MAX_OBJECTIVE_LENGTH);
  });

  it('rejects an unknown workspace with a field-specific error and creates no task', async () => {
    await expect(
      orchestrator.createTask({
        workspaceId: '00000000-0000-0000-0000-000000000000',
        objective: 'do a thing',
      }),
    ).rejects.toMatchObject({
      name: 'TaskValidationError',
      field: 'workspaceId',
    });
    expect(countTasks()).toBe(0);
  });
});

describe('Orchestrator.beginExecution (CONTEXT_LOADING placeholder)', () => {
  it('transitions CREATED → CONTEXT_LOADING → PLANNING, loading context in between', async () => {
    const task = await orchestrator.createTask({
      workspaceId,
      objective: 'plan something',
    });

    const state = await orchestrator.beginExecution(task.id);
    expect(state).toBe('PLANNING');
    expect(taskRow(task.id).state).toBe('PLANNING');

    // The event stream records both transitions in order after the opening one.
    const transitions = taskEvents(task.id)
      .filter((e) => e.kind === 'transition')
      .map((e) => (e.payload as { to: string }).to);
    expect(transitions).toEqual(['CREATED', 'CONTEXT_LOADING', 'PLANNING']);
  });

  it('persists the context references the provider returns', async () => {
    const provider: ContextProvider = {
      retrieveContext: () => Promise.resolve({ refs: ['ctx-a', 'ctx-b'] }),
    };
    const orch = new Orchestrator(
      store,
      stateMachine,
      workspaces,
      canceller,
      audit,
      { contextProvider: provider, registry, permissions },
    );

    const task = await orch.createTask({
      workspaceId,
      objective: 'with context',
    });
    await orch.beginExecution(task.id);

    expect(JSON.parse(taskRow(task.id).context_refs)).toEqual([
      'ctx-a',
      'ctx-b',
    ]);
    const loaded = orch.getTask(task.id);
    expect(loaded?.contextRefs).toEqual(['ctx-a', 'ctx-b']);
  });

  it('defaults to the placeholder provider, which loads no context', async () => {
    const task = await orchestrator.createTask({
      workspaceId,
      objective: 'no context',
    });
    await orchestrator.beginExecution(task.id);
    expect(JSON.parse(taskRow(task.id).context_refs)).toEqual([]);
  });

  it('commits the CONTEXT_LOADING transition before loading context', async () => {
    const observed: TaskState[] = [];
    const provider: ContextProvider = {
      retrieveContext: () => {
        // By the time context loads, the durable state is already CONTEXT_LOADING.
        observed.push(taskRow(task.id).state);
        return Promise.resolve({ refs: [] });
      },
    };
    const orch = new Orchestrator(
      store,
      stateMachine,
      workspaces,
      canceller,
      audit,
      { contextProvider: provider, registry, permissions },
    );
    const task = await orch.createTask({ workspaceId, objective: 'ordering' });
    await orch.beginExecution(task.id);

    expect(observed).toEqual(['CONTEXT_LOADING']);
  });

  it('throws when the task does not exist', async () => {
    await expect(orchestrator.beginExecution('nope')).rejects.toThrow(
      /not found/,
    );
  });
});

describe('Orchestrator.getTask / listActive', () => {
  it('getTask returns the task or undefined', async () => {
    const task = await orchestrator.createTask({
      workspaceId,
      objective: 'find me',
    });
    expect(orchestrator.getTask(task.id)?.id).toBe(task.id);
    expect(orchestrator.getTask('missing')).toBeUndefined();
  });

  it('listActive returns non-terminal tasks newest first and excludes terminal ones', async () => {
    const first = await orchestrator.createTask({
      workspaceId,
      objective: 'first',
    });
    const second = await orchestrator.createTask({
      workspaceId,
      objective: 'second',
    });

    const active = orchestrator.listActive();
    expect(active.map((t: Task) => t.id)).toEqual([second.id, first.id]);

    // Cancel the first; it becomes terminal and drops out of listActive.
    await orchestrator.cancelTask(first.id);
    const afterCancel = orchestrator.listActive();
    expect(afterCancel.map((t: Task) => t.id)).toEqual([second.id]);
  });
});

describe('Orchestrator.cancelTask', () => {
  it('delegates to the canceller and transitions the task to CANCELLED', async () => {
    const task = await orchestrator.createTask({
      workspaceId,
      objective: 'cancel me',
    });
    const result = await orchestrator.cancelTask(task.id);
    expect(result.state).toBe('CANCELLED');
    expect(taskRow(task.id).state).toBe('CANCELLED');
  });
});
