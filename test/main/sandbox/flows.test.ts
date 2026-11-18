import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SqliteStore } from '@main/db/store';
import { nextCronRun, parseCron } from '@main/sandbox/cron';
import { AgentFlowService } from '@main/sandbox/flow-service';
import { flowProblem } from '@shared/agent-flows';

describe('cron', () => {
  const at = (iso: string): Date => new Date(iso);
  it('accepts valid expressions and refuses bad ones', () => {
    for (const ok of ['* * * * *', '*/15 * * * *', '0 9 * * 1-5', '30 8 1,15 * *', '0 0 * * 7']) expect(parseCron(ok), ok).toBeDefined();
    for (const bad of ['', '* * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', 'a b c d e', '*/0 * * * *', '5-1 * * * *']) expect(parseCron(bad), bad).toBeUndefined();
  });
  it('finds the next run in local time', () => {
    expect(nextCronRun('*/15 * * * *', new Date(2026, 10, 18, 10, 7))).toEqual(new Date(2026, 10, 18, 10, 15));
    expect(nextCronRun('0 9 * * *', new Date(2026, 10, 18, 9, 0))).toEqual(new Date(2026, 10, 19, 9, 0));
    // Wed 18 Nov 2026: next Monday-Friday 09:00 after Friday evening is Monday.
    expect(nextCronRun('0 9 * * 1-5', new Date(2026, 10, 20, 18, 0))).toEqual(new Date(2026, 10, 23, 9, 0));
    expect(nextCronRun('0 0 1 * *', new Date(2026, 10, 18))).toEqual(new Date(2026, 11, 1, 0, 0));
    expect(nextCronRun('0 0 * * 0', new Date(2026, 10, 18))).toEqual(new Date(2026, 10, 22, 0, 0));
    expect(nextCronRun('0 0 * * 7', new Date(2026, 10, 18))).toEqual(new Date(2026, 10, 22, 0, 0));
    expect(nextCronRun('0 0 30 2 *', at('2026-01-01T00:00:00'))).toBeUndefined();
    expect(nextCronRun('nonsense', new Date())).toBeUndefined();
  });
});

describe('flowProblem', () => {
  const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  it('accepts a DAG and rejects loops, strays and duplicates', () => {
    expect(flowProblem(nodes, [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'c' }])).toBeUndefined();
    expect(flowProblem(nodes, [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }])).toMatch(/loop/);
    expect(flowProblem(nodes, [{ from: 'a', to: 'z' }])).toMatch(/does not exist/);
    expect(flowProblem(nodes, [{ from: 'a', to: 'a' }])).toMatch(/itself/);
    expect(flowProblem([{ id: 'a' }, { id: 'a' }], [])).toMatch(/share an id/);
  });
});

describe('AgentFlowService', () => {
  const roots: string[] = [];
  const stores: SqliteStore[] = [];
  afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

  async function setup() {
    const root = mkdtempSync(join(tmpdir(), 'flows-'));
    roots.push(root);
    const store = new SqliteStore(join(root, 'f.db'));
    stores.push(store);
    await store.migrate();
    const A = randomUUID(); const B = randomUUID();
    const names: Record<string, string> = { [A]: 'Researcher', [B]: 'Writer' };
    const started: Array<{ id: string; objective: string }> = [];
    const bound: string[] = [];
    const cancelled: string[] = [];
    let clock = new Date(2026, 10, 18, 8, 0);
    const service = new AgentFlowService({
      store,
      agents: { get: (id) => (names[id] !== undefined ? { id, name: names[id]! } : undefined), list: () => Object.entries(names).map(([id, name]) => ({ id, name, description: '' })), startingCli: (_id: string, cli?: string) => cli ?? 'claude-code', bindThread: (threadId: string) => { bound.push(threadId); } },
      workspaceId: () => 'ws',
      now: () => clock,
    });
    service.setTaskCanceller(async (id) => { cancelled.push(id); });
    service.setTaskCreator(async (input) => {
      const task = { id: randomUUID(), threadId: undefined } as never;
      started.push({ id: (task as { id: string }).id, objective: input.objective, ...(input as object) } as never);
      input.onCreated?.(task);
      return task;
    });
    service.setReplyReader((taskId) => `reply of ${started.findIndex((s) => s.id === taskId)}`);
    return { service, started, bound, cancelled, A, B, setClock: (d: Date) => { clock = d; } };
  }

  it('saves flows, validating the graph, agents and schedule', async () => {
    const { service, A } = await setup();
    const base = { name: 'Daily', input: '', nodes: [{ id: 'n1', agentId: A, prompt: 'go', x: 0, y: 0 }], edges: [], schedule: null };
    const saved = service.save(base);
    expect(service.list().map((f) => f.id)).toEqual([saved.id]);
    expect(() => service.save({ ...base, nodes: [{ ...base.nodes[0]!, agentId: randomUUID() }] })).toThrow(/no longer exists/);
    expect(() => service.save({ ...base, schedule: { cron: 'bogus', enabled: true } })).toThrow(/cron/);
    const scheduled = service.save({ ...base, id: saved.id, schedule: { cron: '0 9 * * *', enabled: true } });
    expect(new Date(scheduled.nextRunAt!)).toEqual(new Date(2026, 10, 18, 9, 0));
    expect(service.save({ ...base, id: saved.id, schedule: { cron: '0 9 * * *', enabled: false } }).nextRunAt).toBeNull();
    service.remove(saved.id);
    expect(service.list()).toEqual([]);
  });

  it('runs steps in order, handing each the replies of the steps before it', async () => {
    const { service, started, A, B } = await setup();
    const flow = service.save({
      name: 'Research then write', input: 'cats',
      nodes: [{ id: 'r', agentId: A, prompt: 'Research {{input}}', x: 0, y: 0 }, { id: 'w', agentId: B, prompt: 'Write it up', x: 200, y: 0 }],
      edges: [{ from: 'r', to: 'w' }], schedule: null,
    });
    const run = await service.run(flow.id, 'manual');
    expect(run.status).toBe('running');
    expect(started).toHaveLength(1);
    expect(started[0]!.objective).toContain('Research cats');
    await service.taskSettled({ id: started[0]!.id, state: 'COMPLETED' });
    expect(started).toHaveLength(2);
    expect(started[1]!.objective).toContain('Researcher finished and said:\nreply of 0');
    expect(started[1]!.objective).toContain('Your step:\nWrite it up');
    await service.taskSettled({ id: started[1]!.id, state: 'COMPLETED' });
    const [finished] = service.runs(flow.id);
    expect(finished!.status).toBe('done');
    expect(finished!.nodes.map((n) => n.status)).toEqual(expect.arrayContaining(['done']));
    expect(finished!.finishedAt).not.toBeNull();
  });

  it('runs independent steps together and waits for all of them before a join', async () => {
    const { service, started, A, B } = await setup();
    const flow = service.save({
      name: 'Fan in', input: '',
      nodes: [{ id: 'a', agentId: A, prompt: 'a', x: 0, y: 0 }, { id: 'b', agentId: B, prompt: 'b', x: 0, y: 100 }, { id: 'j', agentId: A, prompt: 'join', x: 200, y: 50 }],
      edges: [{ from: 'a', to: 'j' }, { from: 'b', to: 'j' }], schedule: null,
    });
    await service.run(flow.id, 'manual');
    expect(started).toHaveLength(2);
    await service.taskSettled({ id: started[0]!.id, state: 'COMPLETED' });
    expect(started).toHaveLength(2);
    await service.taskSettled({ id: started[1]!.id, state: 'COMPLETED' });
    expect(started).toHaveLength(3);
  });

  it('puts every step of a flow, whichever agent runs it, in one shared sandbox', async () => {
    const { service, started, A, B } = await setup();
    const flow = service.save({ name: 'Shared', input: '', nodes: [{ id: 'a', agentId: A, prompt: 'a', x: 0, y: 0 }, { id: 'b', agentId: B, prompt: 'b', x: 200, y: 0 }], edges: [{ from: 'a', to: 'b' }], schedule: null });
    await service.run(flow.id, 'manual');
    await service.taskSettled({ id: started[0]!.id, state: 'COMPLETED' });
    const first = service.sandboxScopeFor(started[0]!.id)!;
    const second = service.sandboxScopeFor(started[1]!.id)!;
    expect(first.key).toBe(second.key);
    expect(first.key.startsWith('group-')).toBe(true);
    expect(first).toMatchObject({ name: 'Shared', label: 'workflow' });
    expect(service.sandboxScopeFor('not-a-flow-task')).toBeUndefined();
  });

  it('stops a run: cancels working steps, skips the rest, and lists it in the history without binding steps to agent chats', async () => {
    const { service, started, bound, cancelled, A, B } = await setup();
    const flow = service.save({ name: 'Stoppable', input: '', nodes: [{ id: 'a', agentId: A, prompt: 'a', x: 0, y: 0 }, { id: 'b', agentId: B, prompt: 'b', x: 200, y: 0 }], edges: [{ from: 'a', to: 'b' }], schedule: null });
    const run = await service.run(flow.id, 'manual');
    expect(bound).toEqual([]);
    expect(service.agentIdForTask(started[0]!.id)).toBe(A);
    expect(service.agentIdForTask('other')).toBeUndefined();
    const stopped = await service.stopRun(run.id);
    expect(cancelled).toEqual([started[0]!.id]);
    expect(stopped.status).toBe('failed');
    expect(Object.fromEntries(stopped.nodes.map((n) => [n.nodeId, [n.status, n.note]]))).toEqual({ a: ['failed', 'Stopped by you.'], b: ['skipped', expect.stringContaining('stopped')] });
    // The cancelled task's update arrives afterwards and changes nothing.
    await service.taskSettled({ id: started[0]!.id, state: 'CANCELLED' });
    expect(started).toHaveLength(1);
    const [item] = service.history();
    expect(item).toMatchObject({ flowName: 'Stoppable', labels: { a: 'Researcher', b: 'Writer' } });
    expect(item!.nodes.map((n) => n.nodeId)).toEqual(['a', 'b']);
  });

  it('runs a step on the CLI and model chosen for it', async () => {
    const { service, started, A } = await setup();
    const flow = service.save({ name: 'Pinned', input: '', nodes: [{ id: 'a', agentId: A, cli: 'codex', model: 'gpt-5', effort: 'high', prompt: 'go', x: 0, y: 0 }, { id: 'b', agentId: A, prompt: 'go', x: 0, y: 100 }], edges: [], schedule: null });
    await service.run(flow.id, 'manual');
    const [pinned, plain] = started as unknown as Array<{ agentId: string; runOptions?: unknown }>;
    expect(pinned).toMatchObject({ agentId: 'codex', runOptions: { main: { model: 'gpt-5', effort: 'high' }, mainAgentId: 'codex' } });
    expect(plain).toMatchObject({ agentId: 'claude-code' });
    expect(plain!.runOptions).toBeUndefined();
  });

  it('skips what follows a failed step and marks the run failed', async () => {
    const { service, started, A, B } = await setup();
    const flow = service.save({
      name: 'Fails', input: '',
      nodes: [{ id: 'a', agentId: A, prompt: 'a', x: 0, y: 0 }, { id: 'b', agentId: B, prompt: 'b', x: 200, y: 0 }],
      edges: [{ from: 'a', to: 'b' }], schedule: null,
    });
    await service.run(flow.id, 'manual');
    await service.taskSettled({ id: started[0]!.id, state: 'FAILED' });
    const [run] = service.runs(flow.id);
    expect(run!.status).toBe('failed');
    expect(Object.fromEntries(run!.nodes.map((n) => [n.nodeId, n.status]))).toEqual({ a: 'failed', b: 'skipped' });
    expect(started).toHaveLength(1);
  });

  it('runs due flows on a schedule, once at a time, and sets the next run', async () => {
    const { service, started, A, setClock } = await setup();
    const flow = service.save({ name: 'Hourly', input: '', nodes: [{ id: 'a', agentId: A, prompt: 'a', x: 0, y: 0 }], edges: [], schedule: { cron: '0 * * * *', enabled: true } });
    await service.tick();
    expect(started).toHaveLength(0);
    setClock(new Date(2026, 10, 18, 9, 0, 5));
    await service.tick();
    expect(started).toHaveLength(1);
    expect(service.runs(flow.id)[0]!.trigger).toBe('schedule');
    expect(new Date(service.get(flow.id)!.nextRunAt!)).toEqual(new Date(2026, 10, 18, 10, 0));
    // Still running at 10:00: that firing is skipped, not stacked.
    setClock(new Date(2026, 10, 18, 10, 0, 5));
    await service.tick();
    expect(started).toHaveLength(1);
    expect(new Date(service.get(flow.id)!.nextRunAt!)).toEqual(new Date(2026, 10, 18, 11, 0));
  });
});
