import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '@main/db/store';
import { WorkspaceService } from '@main/domain/workspace-service';
import { AuditLog } from '@main/domain/audit-log';
import { PermissionService } from '@main/domain/permission-service';
import { Registry } from '@main/registry/registry';
import { TaskStateMachine } from '@main/orchestrator/state-machine';
import { TaskCanceller } from '@main/orchestrator/cancellation';
import { Orchestrator } from '@main/orchestrator/orchestrator';
import { TaskRunner } from '@main/orchestrator/task-runner';
import { RecordingTaskEventEmitter } from '@main/orchestrator/event-emitter';
import type { AdapterResult, AdapterSessionHandle, AgentAdapter, AgentSession } from '@shared/adapter';

/** Adapter whose `await` blocks until released or cancelled. */
class GatedAdapter implements AgentAdapter {
  readonly record: AgentAdapter['record'] = {
    id: 'test-agent', class: 'local_tool', name: 'Test Agent', version: '1.0.0',
    capabilities: [{ id: 'objective.fulfill', title: 'Task agent', inputSchema: {}, outputSchema: {}, streaming: true, cancellable: true, resumable: false, requiredPermissions: [] }],
    available: true, config: {},
  };
  started = 0;
  cancelled = 0;
  private waiters: (() => void)[] = [];
  private cancelledSessions = new Set<string>();
  async probeLiveness(_session: AgentSession): Promise<boolean> { return true; }
  async start(_input: unknown): Promise<AdapterSessionHandle> {
    this.started += 1;
    return { sessionId: `gated-${this.started}-${Date.now()}`, adapterId: this.record.id, resumable: false };
  }
  async *stream(_handle: AdapterSessionHandle): AsyncIterable<never> { /* no events */ }
  async await(handle: AdapterSessionHandle): Promise<AdapterResult> {
    if (!this.cancelledSessions.has(handle.sessionId)) {
      await new Promise<void>((resolve) => { this.waiters.push(resolve); });
    }
    return this.cancelledSessions.has(handle.sessionId) ? { status: 'cancelled' } : { status: 'succeeded', exitCode: 0, output: 'done' };
  }
  async cancel(handle: AdapterSessionHandle): Promise<void> {
    this.cancelled += 1;
    this.cancelledSessions.add(handle.sessionId);
    this.release();
  }
  release(): void { for (const resolve of this.waiters.splice(0)) resolve(); }
}

let store: SqliteStore;
let workspaceId: string;
let machine: TaskStateMachine;
let runner: TaskRunner;
let adapter: GatedAdapter;
let root: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'conductor-queue-'));
  store = new SqliteStore(':memory:'); await store.migrate();
  const audit = new AuditLog(store);
  const workspaces = new WorkspaceService(store);
  workspaceId = workspaces.create({ name: 'Test', rootPath: root }).id;
  const permissions = new PermissionService(store, audit);
  const registry = new Registry();
  machine = new TaskStateMachine(store, audit);
  const events = new RecordingTaskEventEmitter();
  const canceller = new TaskCanceller(store, machine, registry, audit);
  const orchestrator = new Orchestrator(store, machine, workspaces, canceller, audit, { registry, permissions, emitter: events, maxStepRetries: 0 });
  adapter = new GatedAdapter();
  registry.register(adapter);
  runner = new TaskRunner({ store, orchestrator, stateMachine: machine, permissions, registry, audit, emitter: events });
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('steer & queue while a task is working', () => {
  it('queues messages and dispatches them FIFO as follow-ups after the task settles', async () => {
    const task = await runner.create({ workspaceId, objective: 'First task' });
    await until(() => adapter.started === 1);
    const first = await runner.enqueueMessage({ taskId: task.id, objective: 'Queued one', mode: 'queue' });
    const second = await runner.enqueueMessage({ taskId: task.id, objective: 'Queued two', mode: 'queue' });
    expect(runner.listQueuedMessages(task.id).map((m) => m.id)).toEqual([first.id, second.id]);
    expect(adapter.started).toBe(1); // nothing new runs while the anchor works

    adapter.release();
    await until(() => runner.listQueuedMessages(task.id).length === 1);
    const dispatchedFirst = store.db.prepare('SELECT dispatched_task_id FROM task_message_queue WHERE id=?').get(first.id) as { dispatched_task_id: string };
    const followUp = machine.getTask(dispatchedFirst.dispatched_task_id)!;
    expect(followUp.objective).toBe('Queued one');
    expect(followUp.parentTaskId).toBe(task.id);
    await until(() => adapter.started === 2);

    adapter.release();
    await until(() => runner.listQueuedMessages(task.id).length === 0);
    await until(() => adapter.started === 3);
    adapter.release();
    const secondId = (store.db.prepare('SELECT dispatched_task_id FROM task_message_queue WHERE id=?').get(second.id) as { dispatched_task_id: string }).dispatched_task_id;
    await runner.waitForIdle(secondId);
    await runner.waitForIdle(followUp.id);
  });

  it('steer cancels the working task and runs the steering message next', async () => {
    const task = await runner.create({ workspaceId, objective: 'Original task' });
    await until(() => adapter.started === 1);
    await runner.enqueueMessage({ taskId: task.id, objective: 'Do it differently', mode: 'steer' });
    await until(() => adapter.cancelled === 1);
    expect(machine.getTask(task.id)?.state).toBe('CANCELLED');
    await until(() => adapter.started === 2);
    const steerTask = store.db.prepare("SELECT objective, parent_task_id FROM tasks WHERE objective='Do it differently'").get() as { objective: string; parent_task_id: string };
    expect(steerTask.parent_task_id).toBe(task.id);
    expect(runner.listQueuedMessages(task.id)).toEqual([]);
    adapter.release();
    const steerTaskId = (store.db.prepare("SELECT id FROM tasks WHERE objective='Do it differently'").get() as { id: string }).id;
    await runner.waitForIdle(steerTaskId);
  });

  it('a plain queue does not dispatch after the user stops the task, and queued messages can be cancelled', async () => {
    const task = await runner.create({ workspaceId, objective: 'Stoppable task' });
    await until(() => adapter.started === 1);
    const entry = await runner.enqueueMessage({ taskId: task.id, objective: 'Later', mode: 'queue' });
    await runner.cancelQueuedMessage(entry.id);
    expect(runner.listQueuedMessages(task.id)).toEqual([]);
    await expect(runner.enqueueMessage({ taskId: '00000000-0000-0000-0000-000000000000', objective: 'x', mode: 'queue' })).rejects.toThrow(/not found/);
    adapter.release();
    await runner.waitForIdle(task.id);
  });
});
