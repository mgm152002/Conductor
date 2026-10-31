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
  RecordingTaskEventEmitter,
  type TaskEventChannel,
} from '@main/orchestrator/event-emitter';
import type { BackoffClock, StepPermissions } from '@main/orchestrator/step-executor';
import { DiskManagedStorage } from '@main/storage/managed-storage';
import { makeFakeAdapter, type FakeAdapterScript } from '../fakes/fake-adapter';
import type {
  AdapterResult,
  CapabilityDescriptor,
} from '@shared/adapter';
import type { PermissionRequirement, TaskState, TaskStepStatus } from '@shared/domain';

// Task 9.3 — RUNNING step execution with streaming, artifacts, and per-event
// checkpointing. These tests drive the Orchestrator.runSteps path end to end
// against a FakeAdapter (scripted streams / crashes) with every time- and
// renderer-bound seam injected, so the durable execution path is exercised
// without Electron and without real wall-clock delay.

let store: SqliteStore;
let audit: AuditLog;
let workspaces: WorkspaceService;
let stateMachine: TaskStateMachine;
let canceller: TaskCanceller;
let permissions: PermissionService;
let tmpRoot: string;
let blobRoot: string;
let workspaceId: string;

/** A backoff clock that records requested delays and never actually waits. */
function recordingBackoff(): BackoffClock & { delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep(ms: number): Promise<void> {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}

/**
 * Build a registry whose single adapter declares the placeholder planner's
 * capability (so planning routes the one-step plan) and runs the given script.
 */
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
      record: { id: 'planner-fake', name: 'Planner Fake', capabilities: [capability] },
      ...(script !== undefined ? { script } : {}),
    }),
  );
  return reg;
}

interface BuildOptions {
  script?: FakeAdapterScript;
  emitter?: RecordingTaskEventEmitter;
  backoffClock?: BackoffClock;
  storage?: DiskManagedStorage;
  stepPermissions?: StepPermissions;
  maxStepRetries?: number;
  baseStepBackoffMs?: number;
  registry?: Registry;
  fallbackModel?: (agentId: string) => string | undefined;
}

function buildOrchestrator(opts: BuildOptions = {}): {
  orchestrator: Orchestrator;
  registry: Registry;
} {
  const registry = opts.registry ?? registryWith(opts.script);
  const localCanceller = new TaskCanceller(store, stateMachine, registry, audit);
  const orchestrator = new Orchestrator(
    store,
    stateMachine,
    workspaces,
    localCanceller,
    audit,
    {
      registry,
      permissions,
      ...(opts.emitter !== undefined ? { emitter: opts.emitter } : {}),
      ...(opts.backoffClock !== undefined
        ? { backoffClock: opts.backoffClock }
        : {}),
      ...(opts.storage !== undefined ? { storage: opts.storage } : {}),
      ...(opts.stepPermissions !== undefined
        ? { stepPermissions: opts.stepPermissions }
        : {}),
      ...(opts.maxStepRetries !== undefined
        ? { maxStepRetries: opts.maxStepRetries }
        : {}),
      ...(opts.baseStepBackoffMs !== undefined
        ? { baseStepBackoffMs: opts.baseStepBackoffMs }
        : {}),
      ...(opts.fallbackModel !== undefined
        ? { fallbackModel: opts.fallbackModel }
        : {}),
    },
  );
  return { orchestrator, registry };
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

function streamEventCount(taskId: string): number {
  return (
    store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND kind = 'stream'`,
      )
      .get(taskId) as { n: number }
  ).n;
}

function checkpointCount(taskId: string): number {
  return (
    store.db
      .prepare('SELECT COUNT(*) AS n FROM checkpoints WHERE task_id = ?')
      .get(taskId) as { n: number }
  ).n;
}

beforeEach(async () => {
  store = new SqliteStore(':memory:');
  await store.migrate();
  audit = new AuditLog(store);
  workspaces = new WorkspaceService(store);
  stateMachine = new TaskStateMachine(store, audit);
  canceller = new TaskCanceller(store, stateMachine, new Registry(), audit);
  permissions = new PermissionService(store, audit);
  void canceller;

  tmpRoot = mkdtempSync(join(tmpdir(), 'conductor-ws-'));
  blobRoot = mkdtempSync(join(tmpdir(), 'conductor-blob-'));
  workspaceId = workspaces.create({ name: 'WS', rootPath: tmpRoot }).id;
});

afterEach(() => {
  store.close();
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(blobRoot, { recursive: true, force: true });
});

describe('Orchestrator.runSteps — happy path', () => {
  it('transitions PLANNING → RUNNING → VERIFYING and marks the step succeeded', async () => {
    const { orchestrator } = buildOrchestrator({
      script: {
        events: [
          { kind: 'progress', data: { pct: 50 } },
          { kind: 'stdout', data: 'working' },
        ],
        result: { status: 'succeeded', exitCode: 0 },
      },
    });
    const taskId = await createPlanned(orchestrator);

    const result = await orchestrator.runSteps(taskId);

    expect(result.outcome).toBe('verifying');
    expect(result.state).toBe('VERIFYING');
    expect(taskState(taskId)).toBe('VERIFYING');
    expect(stepStatuses(taskId)).toEqual(['succeeded']);
  });

  it('records the RUNNING transition before VERIFYING', async () => {
    const { orchestrator } = buildOrchestrator({
      script: { result: { status: 'succeeded' } },
    });
    const taskId = await createPlanned(orchestrator);
    await orchestrator.runSteps(taskId);

    const transitions = (
      store.db
        .prepare(
          `SELECT payload FROM task_events WHERE task_id = ? AND kind = 'transition' ORDER BY rowid ASC`,
        )
        .all(taskId) as { payload: string }[]
    ).map((r) => (JSON.parse(r.payload) as { to: string }).to);

    expect(transitions).toEqual([
      'CREATED',
      'CONTEXT_LOADING',
      'PLANNING',
      'RUNNING',
      'VERIFYING',
    ]);
  });
});

describe('Orchestrator.runSteps — streaming & checkpointing', () => {
  it('persists one stream event and one checkpoint per consumed stream event', async () => {
    const { orchestrator } = buildOrchestrator({
      script: {
        events: [
          { kind: 'progress', data: 1 },
          { kind: 'stdout', data: 2 },
          { kind: 'log', data: 3 },
        ],
        result: { status: 'succeeded' },
      },
    });
    const taskId = await createPlanned(orchestrator);

    const beforeCheckpoints = checkpointCount(taskId);
    await orchestrator.runSteps(taskId);

    // Three stream events consumed → three stream task_events.
    expect(streamEventCount(taskId)).toBe(3);
    // At least one checkpoint per consumed stream event was added.
    expect(checkpointCount(taskId) - beforeCheckpoints).toBeGreaterThanOrEqual(3);
  });

  it('emits task.updated on state change and task.stream per consumed event within the loop', async () => {
    const emitter = new RecordingTaskEventEmitter();
    const { orchestrator } = buildOrchestrator({
      emitter,
      script: {
        events: [
          { kind: 'progress', data: 'a' },
          { kind: 'progress', data: 'b' },
        ],
        result: { status: 'succeeded' },
      },
    });
    const taskId = await createPlanned(orchestrator);
    await orchestrator.runSteps(taskId);

    const channels = emitter.emitted.map((e) => e.channel);
    // RUNNING and VERIFYING each emit a task.updated.
    expect(channels.filter((c: TaskEventChannel) => c === 'task.updated').length).toBe(2);
    // Two stream events → two task.stream emissions.
    const streamEmits = emitter.payloadsFor('task.stream');
    expect(streamEmits).toHaveLength(2);
    expect(streamEmits[0]).toMatchObject({ taskId, sequence: 1 });
    expect(streamEmits[1]).toMatchObject({ taskId, sequence: 2 });
  });
});

describe('Orchestrator.runSteps — artifacts', () => {
  it('persists an artifact stream event through managed storage and links it', async () => {
    const storage = new DiskManagedStorage(blobRoot);
    const { orchestrator } = buildOrchestrator({
      storage,
      script: {
        events: [{ kind: 'artifact', data: { file: 'report.md', bytes: 'hello' } }],
        result: { status: 'succeeded' },
      },
    });
    const taskId = await createPlanned(orchestrator);
    await orchestrator.runSteps(taskId);

    // The stream event payload references a managed-storage artifact id whose
    // blob exists and round-trips.
    const row = store.db
      .prepare(
        `SELECT payload FROM task_events WHERE task_id = ? AND kind = 'stream'`,
      )
      .get(taskId) as { payload: string };
    const payload = JSON.parse(row.payload) as { artifactId?: string };
    expect(payload.artifactId).toBeDefined();
    expect(storage.has(payload.artifactId!)).toBe(true);
  });

  it('links result artifacts as artifact events before the terminal transition', async () => {
    const storage = new DiskManagedStorage(blobRoot);
    const blob = storage.put('final output', 'text/plain');
    const result: AdapterResult = {
      status: 'succeeded',
      artifactIds: [blob.id],
    };
    const { orchestrator } = buildOrchestrator({ storage, script: { result } });
    const taskId = await createPlanned(orchestrator);
    await orchestrator.runSteps(taskId);

    const artifactEvents = store.db
      .prepare(
        `SELECT payload FROM task_events WHERE task_id = ? AND kind = 'artifact'`,
      )
      .all(taskId) as { payload: string }[];
    expect(artifactEvents).toHaveLength(1);
    expect(JSON.parse(artifactEvents[0]!.payload)).toMatchObject({
      artifactId: blob.id,
    });
    expect(taskState(taskId)).toBe('VERIFYING');
  });
});

describe('Orchestrator.runSteps — bounded retries with backoff', () => {
  it('retries a failed step up to the bound then moves to VERIFYING', async () => {
    const backoff = recordingBackoff();
    const { orchestrator } = buildOrchestrator({
      backoffClock: backoff,
      maxStepRetries: 2,
      baseStepBackoffMs: 100,
      script: { result: { status: 'failed', error: 'boom' } },
    });
    const taskId = await createPlanned(orchestrator);

    const result = await orchestrator.runSteps(taskId);

    expect(result.outcome).toBe('failed_to_verifying');
    expect(result.state).toBe('VERIFYING');
    expect(stepStatuses(taskId)).toEqual(['failed']);
    // Two retries → two backoff sleeps with exponential delays 100, 200.
    expect(backoff.delays).toEqual([100, 200]);
  });

  it('retries a mid-stream crash with backoff, records an error event, then fails to VERIFYING', async () => {
    const backoff = recordingBackoff();
    // The fake crashes at stream on EVERY call, so with 1 retry it still fails;
    // assert the crash path records an error event and retries once.
    const { orchestrator } = buildOrchestrator({
      backoffClock: backoff,
      maxStepRetries: 1,
      script: { crashAt: 'stream', crashMessage: 'stream exploded' },
    });
    const taskId = await createPlanned(orchestrator);

    const result = await orchestrator.runSteps(taskId);

    expect(result.outcome).toBe('failed_to_verifying');
    expect(stepStatuses(taskId)).toEqual(['failed']);
    // One retry attempted.
    expect(backoff.delays).toHaveLength(1);
    const errorEvents = store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND kind = 'error'`,
      )
      .get(taskId) as { n: number };
    expect(errorEvents.n).toBeGreaterThanOrEqual(1);
  });

  it('does not retry on exit-code-0 but a cancelled result', async () => {
    const backoff = recordingBackoff();
    const { orchestrator } = buildOrchestrator({
      backoffClock: backoff,
      maxStepRetries: 3,
      script: { result: { status: 'cancelled', exitCode: 0 } },
    });
    const taskId = await createPlanned(orchestrator);
    const result = await orchestrator.runSteps(taskId);

    expect(result.outcome).toBe('failed_to_verifying');
    expect(stepStatuses(taskId)).toEqual(['cancelled']);
    expect(backoff.delays).toEqual([]); // cancelled is never retried
  });
});

describe('Orchestrator.runSteps — agent fallback', () => {
  const agentCapability = (id: string): CapabilityDescriptor => ({
    id: `objective.fulfill.${id}`,
    title: `Fulfill objective (${id})`,
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    streaming: true,
    cancellable: true,
    resumable: false,
    requiredPermissions: [],
  });

  function fallbackRegistry(): {
    registry: Registry;
    opencode: ReturnType<typeof makeFakeAdapter>;
    codex: ReturnType<typeof makeFakeAdapter>;
  } {
    const opencode = makeFakeAdapter({
      record: { id: 'opencode', name: 'OpenCode', capabilities: [agentCapability('opencode')] },
      script: { result: { status: 'failed', error: 'The selected model is not available for this account' } },
    });
    const codex = makeFakeAdapter({
      record: { id: 'codex', name: 'Codex CLI', capabilities: [agentCapability('codex')] },
      script: { result: { status: 'succeeded' } },
    });
    const registry = new Registry();
    registry.register(opencode);
    registry.register(codex);
    return { registry, opencode, codex };
  }

  async function createAgentStep(orchestrator: Orchestrator): Promise<string> {
    const task = await orchestrator.createTask({ workspaceId, objective: 'do the thing' });
    await orchestrator.beginExecution(task.id, {
      steps: [{
        id: 'step-1',
        description: 'Fulfill the objective',
        requiredCapability: 'objective.fulfill.opencode',
        input: { models: { opencode: 'model-primary', codex: 'codex-default' } },
      }],
    });
    return task.id;
  }

  it('retries model_unavailable on the same agent with its fallback model before switching agents', async () => {
    const { registry, opencode, codex } = fallbackRegistry();
    const { orchestrator } = buildOrchestrator({
      registry,
      maxStepRetries: 0,
      fallbackModel: (agentId) => agentId === 'opencode' ? 'model-fallback' : undefined,
    });
    const taskId = await createAgentStep(orchestrator);

    const result = await orchestrator.runSteps(taskId);

    expect(result.outcome).toBe('verifying');
    expect(opencode.calls.started).toHaveLength(2);
    expect(opencode.calls.started[0]).toMatchObject({ models: { opencode: 'model-primary' } });
    expect(opencode.calls.started[1]).toMatchObject({ models: { opencode: 'model-fallback' } });
    expect(codex.calls.started).toHaveLength(1);
    expect(codex.calls.started[0]).toMatchObject({ models: { codex: 'codex-default' } });

    const sessions = store.db
      .prepare('SELECT adapter_id FROM agent_sessions WHERE task_id = ? ORDER BY rowid ASC')
      .all(taskId) as { adapter_id: string }[];
    expect(sessions.map((row) => row.adapter_id)).toEqual(['opencode', 'opencode', 'codex']);

    const modelFallback = audit.list().find((event) => event.action === 'task.step.model_fallback');
    expect(modelFallback?.redactedPayload).toMatchObject({
      agentId: 'opencode',
      model: 'model-fallback',
      reason: 'model_unavailable',
    });
    expect(audit.list().filter((event) => event.action === 'task.step.agent_fallback')).toHaveLength(1);

    const logs = store.db
      .prepare("SELECT payload FROM task_events WHERE task_id = ? AND kind = 'log' ORDER BY rowid ASC")
      .all(taskId) as { payload: string }[];
    expect(logs.map((row) => JSON.parse(row.payload))).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelFallback: true, agentId: 'opencode', model: 'model-fallback' }),
      expect.objectContaining({ agentFallback: true }),
    ]));
  });

  it('switches agents without a model retry when the fallback resolver returns undefined', async () => {
    const { registry, opencode, codex } = fallbackRegistry();
    const { orchestrator } = buildOrchestrator({
      registry,
      maxStepRetries: 0,
      fallbackModel: () => undefined,
    });
    const taskId = await createAgentStep(orchestrator);

    const result = await orchestrator.runSteps(taskId);

    expect(result.outcome).toBe('verifying');
    expect(opencode.calls.started).toHaveLength(1);
    expect(codex.calls.started).toHaveLength(1);
    expect(audit.list().filter((event) => event.action === 'task.step.model_fallback')).toHaveLength(0);
    expect(audit.list().filter((event) => event.action === 'task.step.agent_fallback')).toHaveLength(1);
  });

  it('re-points a quota-exhausted step to the next preferred agent and announces the switch', async () => {
    // OpenCode is the planner's assigned agent and runs out of quota; Codex is
    // the next preferred available agent and finishes the step instead.
    const opencode = makeFakeAdapter({
      record: { id: 'opencode', name: 'OpenCode', capabilities: [agentCapability('opencode')] },
      script: { result: { status: 'failed', error: 'You have hit your usage limit' } },
    });
    const codex = makeFakeAdapter({
      record: { id: 'codex', name: 'Codex CLI', capabilities: [agentCapability('codex')] },
      script: { result: { status: 'succeeded' } },
    });
    const registry = new Registry();
    registry.register(opencode);
    registry.register(codex);
    const { orchestrator } = buildOrchestrator({ registry, maxStepRetries: 0 });

    const task = await orchestrator.createTask({ workspaceId, objective: 'do the thing' });
    await orchestrator.beginExecution(task.id, {
      steps: [{ id: 'step-1', description: 'Fulfill the objective', requiredCapability: 'objective.fulfill.opencode' }],
    });
    const result = await orchestrator.runSteps(task.id);

    expect(result.outcome).toBe('verifying');
    expect(stepStatuses(task.id)).toEqual(['succeeded']);
    expect(opencode.calls.awaited).toBe(1);
    expect(codex.calls.awaited).toBe(1);

    const logs = store.db
      .prepare("SELECT payload FROM task_events WHERE task_id = ? AND kind = 'log' ORDER BY created_at ASC")
      .all(task.id) as { payload: string }[];
    const fallback = logs
      .map((row) => JSON.parse(row.payload) as { message?: string; agentFallback?: boolean })
      .find((payload) => payload.agentFallback === true);
    expect(fallback?.message).toBe('OpenCode is out of capacity, so Codex CLI is taking over this step.');
    expect(fallback).toMatchObject({
      handoff: { fromAgentId: 'opencode', fromAgent: 'OpenCode', toAgentId: 'codex', toAgent: 'Codex CLI' },
    });
  });

  it('still falls back to the next CLI when the user chose the model, with the reason recorded', async () => {
    // Fallback is a feature, like chat threads: OpenCode + a chosen model
    // failed, so Codex takes over — as a structured handoff saying why, and
    // running its own model, not the foreign model id chosen for OpenCode.
    const { registry, opencode, codex } = fallbackRegistry();
    const { orchestrator } = buildOrchestrator({
      registry,
      maxStepRetries: 0,
      fallbackModel: () => undefined,
    });
    const taskId = await createAgentStep(orchestrator);
    store.db.prepare('UPDATE tasks SET run_options = ? WHERE id = ?')
      .run(JSON.stringify({ main: { model: 'opencode/deepseek-v4' }, mainAgentId: 'opencode' }), taskId);

    const result = await orchestrator.runSteps(taskId);

    expect(result.outcome).toBe('verifying');
    expect(opencode.calls.started).toHaveLength(1);
    expect(codex.calls.started).toHaveLength(1);
    expect(codex.calls.started[0]).toMatchObject({ models: { codex: 'codex-default' } });
    expect(stepStatuses(taskId)).toEqual(['succeeded']);

    const logs = store.db
      .prepare("SELECT payload FROM task_events WHERE task_id = ? AND kind = 'log' ORDER BY rowid ASC")
      .all(taskId) as { payload: string }[];
    const fallback = logs.map((row) => JSON.parse(row.payload) as Record<string, unknown>)
      .find((payload) => payload['agentFallback'] === true);
    expect(fallback).toMatchObject({
      handoff: {
        fromAgentId: 'opencode', toAgentId: 'codex',
        reason: expect.stringContaining('The selected model is not available for this account'),
      },
    });
  });

  it('records the fallback-model retry as a same-agent handoff with a clean reason', async () => {
    const { registry, opencode, codex } = fallbackRegistry();
    const { orchestrator } = buildOrchestrator({
      registry,
      maxStepRetries: 0,
      fallbackModel: (agentId) => agentId === 'opencode' ? 'model-fallback' : undefined,
    });
    const taskId = await createAgentStep(orchestrator);

    await orchestrator.runSteps(taskId);

    expect(opencode.calls.started).toHaveLength(2);
    expect(opencode.calls.started[1]).toMatchObject({ models: { opencode: 'model-fallback' } });
    expect(codex.calls.started).toHaveLength(1);
    const logs = store.db
      .prepare("SELECT payload FROM task_events WHERE task_id = ? AND kind = 'log' ORDER BY rowid ASC")
      .all(taskId) as { payload: string }[];
    const modelFallback = logs.map((row) => JSON.parse(row.payload) as Record<string, unknown>)
      .find((payload) => payload['modelFallback'] === true);
    expect(modelFallback).toMatchObject({
      handoff: {
        fromAgentId: 'opencode', toAgentId: 'opencode', toModel: 'model-fallback',
        reason: expect.stringContaining("couldn't run the selected model"),
      },
    });
  });
});

describe('Orchestrator.runSteps — idempotent resume', () => {
  it('never re-executes a step already marked succeeded', async () => {
    const { orchestrator } = buildOrchestrator({
      script: { result: { status: 'succeeded' } },
    });
    const taskId = await createPlanned(orchestrator);

    // First run succeeds and moves to VERIFYING.
    await orchestrator.runSteps(taskId);
    expect(stepStatuses(taskId)).toEqual(['succeeded']);
    const sessionsAfterFirst = (
      store.db
        .prepare('SELECT COUNT(*) AS n FROM agent_sessions WHERE task_id = ?')
        .get(taskId) as { n: number }
    ).n;

    // Drive the task back to RUNNING (as a resume would) and re-run: the
    // already-succeeded step is skipped — no new session is started.
    stateMachine.transition({ taskId, to: 'RUNNING', eventPayload: { reason: 'retry' } });
    const result = await orchestrator.runSteps(taskId);

    expect(result.outcome).toBe('verifying');
    const sessionsAfterSecond = (
      store.db
        .prepare('SELECT COUNT(*) AS n FROM agent_sessions WHERE task_id = ?')
        .get(taskId) as { n: number }
    ).n;
    expect(sessionsAfterSecond).toBe(sessionsAfterFirst);
  });
});

describe('Orchestrator.runSteps — approval gating (Requirement 9.2)', () => {
  const writeReq: PermissionRequirement = { kind: 'filesystem_write' };

  it('gates a step requiring approval through WAITING_FOR_APPROVAL without running an adapter', async () => {
    // assisted_execution permits a consequential write only behind approval.
    permissions.grant({
      subject: { type: 'agent', id: 'orchestrator' },
      profile: 'assisted_execution',
    });
    const stepPermissions: StepPermissions = () => [writeReq];
    const { orchestrator, registry } = buildOrchestrator({
      stepPermissions,
      script: { result: { status: 'succeeded' } },
    });
    const taskId = await createPlanned(orchestrator);

    const result = await orchestrator.runSteps(taskId);

    expect(result.outcome).toBe('waiting_for_approval');
    expect(taskState(taskId)).toBe('WAITING_FOR_APPROVAL');
    // The step never ran: no adapter session was started and the step is still pending.
    expect(stepStatuses(taskId)).toEqual(['pending']);
    const adapter = registry.resolve('planner-fake');
    // FakeAdapter records starts; none should have happened.
    expect((adapter as unknown as { calls: { started: unknown[] } }).calls.started).toHaveLength(0);

    // A pending approval request was created for the task.
    const pending = permissions.pendingApprovals(taskId);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.requirements).toEqual([writeReq]);
  });

  it('does not gate when the subject is granted trusted_automation', async () => {
    permissions.grant({
      subject: { type: 'agent', id: 'orchestrator' },
      profile: 'trusted_automation',
    });
    const stepPermissions: StepPermissions = () => [writeReq];
    const { orchestrator } = buildOrchestrator({
      stepPermissions,
      script: { result: { status: 'succeeded' } },
    });
    const taskId = await createPlanned(orchestrator);
    const result = await orchestrator.runSteps(taskId);

    expect(result.outcome).toBe('verifying');
    expect(stepStatuses(taskId)).toEqual(['succeeded']);
  });
});

describe('Orchestrator.runSteps — guards', () => {
  it('is a no-op on a terminal task', async () => {
    const { orchestrator } = buildOrchestrator({
      script: { result: { status: 'succeeded' } },
    });
    const taskId = await createPlanned(orchestrator);
    await orchestrator.cancelTask(taskId);
    expect(taskState(taskId)).toBe('CANCELLED');

    const result = await orchestrator.runSteps(taskId);
    expect(result.outcome).toBe('already_terminal');
    expect(result.state).toBe('CANCELLED');
  });

  it('throws when the task does not exist', async () => {
    const { orchestrator } = buildOrchestrator();
    await expect(orchestrator.runSteps('missing')).rejects.toThrow(/not found/);
  });
});
