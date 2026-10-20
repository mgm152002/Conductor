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
import { ResumeService } from '@main/orchestrator/resume-service';
import { PLACEHOLDER_PLAN_CAPABILITY } from '@main/orchestrator/planner';
import type { StepPermissions } from '@main/orchestrator/step-executor';
import { makeFakeAdapter, type FakeAdapterScript } from '../fakes/fake-adapter';
import type {
  CapabilityDescriptor,
  TaskState,
  TaskStepStatus,
} from '@shared/domain';

// Task 11.2 — idempotent resume and the Resume Center action handler. These
// tests drive ResumeService.act against real orchestrator machinery (the
// write-ahead state machine, the StepExecutor, the TaskCanceller) with a
// FakeAdapter, so resume/restart/discard/inspect and the confirmation gates
// (Requirement 8.7, 8.8) are exercised end to end without Electron.

let store: SqliteStore;
let audit: AuditLog;
let workspaces: WorkspaceService;
let stateMachine: TaskStateMachine;
let permissions: PermissionService;
let tmpRoot: string;
let workspaceId: string;

function registryWith(script?: FakeAdapterScript): Registry {
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
      ...(script !== undefined ? { script } : {}),
    }),
  );
  return reg;
}

function build(opts: { script?: FakeAdapterScript; stepPermissions?: StepPermissions } = {}): {
  orchestrator: Orchestrator;
  resume: ResumeService;
  canceller: TaskCanceller;
} {
  const registry = registryWith(opts.script);
  const canceller = new TaskCanceller(store, stateMachine, registry, audit);
  const orchestrator = new Orchestrator(
    store,
    stateMachine,
    workspaces,
    canceller,
    audit,
    { registry, permissions },
  );
  const resume = new ResumeService(
    store,
    stateMachine,
    orchestrator,
    canceller,
    audit,
    opts.stepPermissions !== undefined
      ? { stepPermissions: opts.stepPermissions }
      : {},
  );
  return { orchestrator, resume, canceller };
}

async function createPlanned(orchestrator: Orchestrator): Promise<string> {
  const task = await orchestrator.createTask({
    workspaceId,
    objective: 'do the thing',
  });
  const state = await orchestrator.beginExecution(task.id);
  expect(state).toBe('PLANNING');
  return task.id;
}

function taskState(taskId: string): TaskState {
  return (
    store.db.prepare('SELECT state FROM tasks WHERE id = ?').get(taskId) as {
      state: TaskState;
    }
  ).state;
}

function stepStatuses(taskId: string): TaskStepStatus[] {
  const rows = store.db
    .prepare(
      'SELECT status FROM task_steps WHERE task_id = ? ORDER BY ordinal ASC',
    )
    .all(taskId) as { status: TaskStepStatus }[];
  return rows.map((r) => r.status);
}

/** Force the single planned step to `succeeded`, as if it ran before a crash. */
function markOnlyStepSucceeded(taskId: string): string {
  const row = store.db
    .prepare('SELECT id FROM task_steps WHERE task_id = ? ORDER BY ordinal ASC LIMIT 1')
    .get(taskId) as { id: string };
  store.db
    .prepare(`UPDATE task_steps SET status = 'succeeded' WHERE id = ?`)
    .run(row.id);
  return row.id;
}

/** Drive the task to RECOVERABLE_INTERRUPTION via a legal path (as onBoot would). */
function toRecoverableInterruption(taskId: string): void {
  stateMachine.transition({
    taskId,
    to: 'RECOVERABLE_INTERRUPTION',
    eventPayload: { reason: 'boot-reconcile' },
  });
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

describe('ResumeService.act — resume (idempotent)', () => {
  it('never re-executes a step already marked succeeded (Property 4)', async () => {
    // A FakeAdapter whose start throws: if resume re-ran the succeeded step the
    // task would be driven to a failure. Because the only step is already
    // succeeded, the adapter must never be started and the task goes straight
    // to VERIFYING.
    const { orchestrator, resume } = build({
      script: { crashAt: 'start', crashMessage: 'should never start' },
    });
    const taskId = await createPlanned(orchestrator);
    markOnlyStepSucceeded(taskId);
    toRecoverableInterruption(taskId);

    const result = await resume.act({ taskId, action: 'resume' });

    expect(result.status).toBe('applied');
    expect(result.state).toBe('VERIFYING');
    expect(taskState(taskId)).toBe('VERIFYING');
    // Still succeeded — not re-run, not reset.
    expect(stepStatuses(taskId)).toEqual(['succeeded']);
  });

  it('continues a RECOVERABLE_INTERRUPTION task onto the RUNNING path and runs the pending step', async () => {
    const { orchestrator, resume } = build({
      script: { result: { status: 'succeeded' } },
    });
    const taskId = await createPlanned(orchestrator);
    toRecoverableInterruption(taskId);

    const result = await resume.act({ taskId, action: 'resume' });

    expect(result.status).toBe('applied');
    expect(result.state).toBe('VERIFYING');
    expect(stepStatuses(taskId)).toEqual(['succeeded']);
  });
});

describe('ResumeService.act — consequential resume confirmation (Req 8.7)', () => {
  const consequential: StepPermissions = () => [{ kind: 'destructive' }];

  it('refuses an unconfirmed resume that would re-execute a consequential step', async () => {
    const { orchestrator, resume } = build({
      script: { result: { status: 'succeeded' } },
      stepPermissions: consequential,
    });
    const taskId = await createPlanned(orchestrator);
    toRecoverableInterruption(taskId);

    const result = await resume.act({ taskId, action: 'resume' });

    expect(result.status).toBe('confirmation_required');
    expect(result.confirmationReason).toBe('consequential');
    // Nothing changed — the task is still interrupted, the step still pending.
    expect(taskState(taskId)).toBe('RECOVERABLE_INTERRUPTION');
    expect(stepStatuses(taskId)).toEqual(['pending']);
  });

  it('proceeds once the resume is explicitly confirmed', async () => {
    const { orchestrator, resume } = build({
      script: { result: { status: 'succeeded' } },
      stepPermissions: consequential,
    });
    const taskId = await createPlanned(orchestrator);
    toRecoverableInterruption(taskId);

    const result = await resume.act({ taskId, action: 'resume', confirmed: true });

    expect(result.status).toBe('applied');
    expect(result.state).toBe('VERIFYING');
  });

  it('does not require confirmation when no pending step is consequential', async () => {
    const { orchestrator, resume } = build({
      script: { result: { status: 'succeeded' } },
      // Mark the only step succeeded so there is no pending consequential step.
      stepPermissions: consequential,
    });
    const taskId = await createPlanned(orchestrator);
    markOnlyStepSucceeded(taskId);
    toRecoverableInterruption(taskId);

    const result = await resume.act({ taskId, action: 'resume' });

    expect(result.status).toBe('applied');
  });
});

describe('ResumeService.act — restart', () => {
  it('resets succeeded steps to pending and re-runs the task', async () => {
    const { orchestrator, resume } = build({
      script: { result: { status: 'succeeded' } },
    });
    const taskId = await createPlanned(orchestrator);
    markOnlyStepSucceeded(taskId);
    toRecoverableInterruption(taskId);

    const result = await resume.act({ taskId, action: 'restart' });

    expect(result.status).toBe('applied');
    // The step was reset and re-run to succeeded again; task reached VERIFYING.
    expect(result.state).toBe('VERIFYING');
    expect(stepStatuses(taskId)).toEqual(['succeeded']);
  });
});

describe('ResumeService.act — discard confirmation (Req 8.8)', () => {
  it('refuses an unconfirmed discard and changes nothing', async () => {
    const { orchestrator, resume } = build();
    const taskId = await createPlanned(orchestrator);
    toRecoverableInterruption(taskId);

    const result = await resume.act({ taskId, action: 'discard' });

    expect(result.status).toBe('confirmation_required');
    expect(result.confirmationReason).toBe('discard');
    expect(taskState(taskId)).toBe('RECOVERABLE_INTERRUPTION');
  });

  it('cancels the task once discard is confirmed (artifacts preserved)', async () => {
    const { orchestrator, resume } = build();
    const taskId = await createPlanned(orchestrator);
    toRecoverableInterruption(taskId);

    const result = await resume.act({ taskId, action: 'discard', confirmed: true });

    expect(result.status).toBe('applied');
    expect(result.state).toBe('CANCELLED');
    expect(taskState(taskId)).toBe('CANCELLED');
  });
});

describe('ResumeService.act — inspect', () => {
  it('is a read-only no-op that reports the current state', async () => {
    const { orchestrator, resume } = build();
    const taskId = await createPlanned(orchestrator);
    toRecoverableInterruption(taskId);

    const result = await resume.act({ taskId, action: 'inspect' });

    expect(result.status).toBe('noop');
    expect(result.state).toBe('RECOVERABLE_INTERRUPTION');
    // State unchanged.
    expect(taskState(taskId)).toBe('RECOVERABLE_INTERRUPTION');
  });
});
