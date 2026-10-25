import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '@main/db/store';
import { WorkspaceService } from '@main/domain/workspace-service';
import { PermissionService } from '@main/domain/permission-service';
import { AuditLog } from '@main/domain/audit-log';
import { Registry } from '@main/registry/registry';
import { CliRegistrar } from '@main/catalog/registrar';
import { TaskStateMachine } from '@main/orchestrator/state-machine';
import { TaskCanceller } from '@main/orchestrator/cancellation';
import { Orchestrator } from '@main/orchestrator/orchestrator';
import { TaskRunner } from '@main/orchestrator/task-runner';
import { TaskQueries } from '@main/orchestrator/task-queries';
import { evidenceEvaluator } from '@main/orchestrator/evidence-evaluator';
import { RecordingTaskEventEmitter } from '@main/orchestrator/event-emitter';
import { ToolApprovalBroker } from '@main/orchestrator/tool-approvals';
import { replyFor } from '@main/orchestrator/thread-context';
import { AgentPlanner } from '@main/plan/agent-planner';
import { UsageRecorder, usageSummary } from '@main/usage/usage';
import { DiskManagedStorage } from '@main/storage/managed-storage';

// Plan mode end to end: a planner agent (fake ACP agent) returns a plan, the
// plan's tasks run on the agents it names, wave-0 tasks in parallel, later
// tasks receive their dependencies' replies, and the documents are written.

const FIXTURE = resolve(__dirname, '../fixtures/acp-plan-fixture.mjs');
const roots: string[] = [];
const stores: SqliteStore[] = [];
const savedEnv = { ...process.env };
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

async function setup(options: { plan?: unknown; delay?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'conductor-plan-'));
  roots.push(root);
  process.env['PLAN_FIXTURE_LOG'] = join(root, 'agents.log');
  if (options.plan !== undefined) process.env['PLAN_FIXTURE_PLAN'] = JSON.stringify(options.plan);
  if (options.delay !== undefined) process.env['PLAN_FIXTURE_DELAY'] = String(options.delay);
  const store = new SqliteStore(':memory:');
  stores.push(store);
  await store.migrate();
  const workspaces = new WorkspaceService(store);
  const workspace = workspaces.create({ name: 'W', rootPath: root });
  const audit = new AuditLog(store);
  const permissions = new PermissionService(store, audit);
  permissions.grant({ subject: { type: 'agent', id: 'orchestrator' }, profile: 'trusted_automation' });
  const registry = new Registry();
  const broker = new ToolApprovalBroker(store, permissions);
  const registrar = new CliRegistrar(registry, undefined, undefined, (request, signal) => broker.request(request, signal));
  for (const [id, name] of [['opencode', 'OpenCode'], ['kiro', 'Kiro CLI']] as const) {
    const binary = join(root, `${id}-bin`);
    writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" ${id} "$@"\n`);
    chmodSync(binary, 0o755);
    expect(registrar.ensureRegistered({ id, displayName: name, candidateBinaryNames: [binary], installMethod: { kind: 'unconfigured' } }, binary)).toEqual({ kind: 'registered' });
  }
  const machine = new TaskStateMachine(store, audit);
  const canceller = new TaskCanceller(store, machine, registry, audit);
  const emitter = new RecordingTaskEventEmitter();
  const usage = new UsageRecorder(store);
  const agentName = (id: string) => (registry.has(id) ? registry.resolve(id).record.name : id);
  const baseInput = (task: { objective: string; acceptanceCriteria: string[] }) => ({ objective: task.objective, acceptanceCriteria: task.acceptanceCriteria, rootPath: root, mode: 'trusted_automation', contextData: [] });
  const planner = new AgentPlanner({ store, registry, usage, emitter, agentName, getTask: (id) => machine.getTask(id), baseInput: (task) => baseInput(task) });
  const orchestrator = new Orchestrator(store, machine, workspaces, canceller, audit, {
    registry, permissions, emitter, maxStepRetries: 0, criterionEvaluator: evidenceEvaluator(store), planner, usage,
    executionInput: (task) => baseInput(task),
    onStepSettled: (taskId) => { planner.refresh(taskId); },
  });
  const runner = new TaskRunner({ store, orchestrator, stateMachine: machine, permissions, registry, audit, emitter, toolApprovals: broker, planMode: planner });
  const storage = new DiskManagedStorage(join(root, '.blobs'));
  const queries = new TaskQueries(store, orchestrator, permissions, storage, (id) => planner.view(id));
  return { store, runner, machine, workspace, orchestrator, root, queries, agentName };
}

function agentLog(root: string): Record<string, { start: number; end: number }> {
  const out: Record<string, { start: number; end: number }> = {};
  if (!existsSync(join(root, 'agents.log'))) return out;
  for (const line of readFileSync(join(root, 'agents.log'), 'utf8').trim().split('\n')) {
    const [kind, id, at] = line.split(' ');
    out[id!] ??= { start: 0, end: 0 };
    out[id!]![kind as 'start' | 'end'] = Number(at);
  }
  return out;
}

describe('plan mode', () => {
  it('plans with the chosen agent, runs independent tasks in parallel, and writes the documents', async () => {
    const { runner, machine, workspace, store, root, queries, agentName } = await setup();
    const task = await runner.create({ workspaceId: workspace.id, objective: 'Add notes', plan: true, agentId: 'opencode', acceptanceCriteria: ['contains: done 2.1'] });
    await runner.waitForIdle(task.id);
    expect(machine.getTask(task.id)?.state).toBe('COMPLETED');

    const details = queries.details(task.id);
    expect(details.plan?.status).toBe('ready');
    expect(details.plan?.waves).toEqual([{ id: 0, tasks: ['1.1', '1.2'] }, { id: 1, tasks: ['2.1'] }]);
    // Each task ran on its agent; the unknown agent fell back to the planner.
    const byDescription = Object.fromEntries(details.steps.map((s) => [s.description, s.assignedAdapterId]));
    expect(byDescription).toEqual({ '1.1 Storage': 'kiro', '1.2 List view': 'opencode', '2.1 Wire up': 'opencode' });
    expect(details.steps.every((s) => s.status === 'succeeded')).toBe(true);

    // Wave 0 ran in parallel; 2.1 started only after both finished.
    const times = agentLog(root);
    expect(times['1.2']!.start).toBeLessThan(times['1.1']!.end);
    expect(times['1.1']!.start).toBeLessThan(times['1.2']!.end);
    expect(times['2.1']!.start).toBeGreaterThanOrEqual(Math.max(times['1.1']!.end, times['1.2']!.end));

    // 2.1 received both dependency replies; the thread reply has every task.
    const reply = replyFor(store, task.id);
    expect(reply).toContain('done 2.1 by opencode deps=2');
    expect(reply).toContain('### 1.1 Storage\ndone 1.1 by kiro deps=0');

    // Documents, with finished tasks ticked and the waves graph.
    const docsDir = details.plan!.docsDir!;
    expect(docsDir.startsWith(join(root, '.conductor', 'plans'))).toBe(true);
    expect(readdirSync(docsDir).sort()).toEqual(['requirements.md', 'tasks.md']);
    const tasksMd = readFileSync(join(docsDir, 'tasks.md'), 'utf8');
    expect(tasksMd).toContain('- [x] 1.1 Storage');
    expect(tasksMd).toContain('- [x] 2.1 Wire up');
    expect(tasksMd).toContain('_Agent: Kiro CLI · moderate_');
    expect(tasksMd).toContain('## Task Dependency Graph');
    expect(tasksMd).toContain('{ "id": 0, "tasks": ["1.1", "1.2"] }');
    expect(readFileSync(join(docsDir, 'requirements.md'), 'utf8')).toContain('### Requirement 1: Notes');

    // Usage: the planner and the three task sessions.
    expect(details.usage?.total).toMatchObject({ sessions: 4, inputTokens: 400, outputTokens: 80, totalTokens: 480, cachedInputTokens: 160 });
    expect(details.usage?.byStep['planner']).toMatchObject({ sessions: 1 });
    const summary = usageSummary(store, { range: 'all' }, agentName);
    expect(summary.byAgent.map((a) => [a.label, a.sessions])).toEqual([['OpenCode', 3], ['Kiro CLI', 1]]);
    expect(summary.byProject[0]).toMatchObject({ label: 'W', totalTokens: 480 });
  }, 30_000);

  it('skips the dependents of a failed task and fails the task', async () => {
    const plan = {
      title: 'Failing', requirements: [{ id: '1', title: 'R', acceptanceCriteria: ['x'] }],
      groups: [{ id: '1', title: 'G', tasks: [
        { id: '1.1', title: 'FAIL here', agent: 'kiro' },
        { id: '1.2', title: 'Independent', agent: 'opencode' },
        { id: '1.3', title: 'After', dependsOn: ['1.1'], agent: 'opencode' },
      ] }],
    };
    const { runner, machine, workspace, queries } = await setup({ plan });
    const task = await runner.create({ workspaceId: workspace.id, objective: 'Build the notes feature and fix the list', plan: true, agentId: 'kiro' });
    await runner.waitForIdle(task.id);
    expect(machine.getTask(task.id)?.state).toBe('FAILED');
    const status = Object.fromEntries(queries.details(task.id).steps.map((s) => [s.description, s.status]));
    expect(status).toEqual({ '1.1 FAIL here': 'failed', '1.2 Independent': 'succeeded', '1.3 After': 'skipped' });
  }, 30_000);

  it('blocks the task with the reason when the plan is invalid', async () => {
    const plan = { title: 'Cyclic', requirements: [{ id: '1', title: 'R', acceptanceCriteria: ['x'] }],
      groups: [{ id: '1', title: 'G', tasks: [{ id: '1.1', title: 'A', dependsOn: ['1.2'] }, { id: '1.2', title: 'B', dependsOn: ['1.1'] }] }] };
    const { runner, machine, workspace, queries } = await setup({ plan });
    const task = await runner.create({ workspaceId: workspace.id, objective: 'Update the notes module', plan: true, agentId: 'opencode' });
    await runner.waitForIdle(task.id);
    expect(machine.getTask(task.id)?.state).toBe('BLOCKED');
    expect(machine.getTask(task.id)?.recommendedNextAction).toContain('cycle');
    expect(queries.details(task.id).plan).toMatchObject({ status: 'failed' });
  }, 30_000);

  it('cancels every running agent at once', async () => {
    const { runner, machine, workspace, orchestrator, store } = await setup({ delay: 20_000 });
    const task = await runner.create({ workspaceId: workspace.id, objective: 'Add notes', plan: true, agentId: 'opencode' });
    for (let i = 0; i < 200; i += 1) {
      const live = store.db.prepare("SELECT COUNT(*) AS n FROM agent_sessions WHERE task_id = ? AND step_id IS NOT NULL AND status = 'live'").get(task.id) as { n: number };
      if (live.n === 2) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const started = Date.now();
    const result = await orchestrator.cancelTask(task.id);
    expect(result.sessions.length).toBe(2);
    expect(Date.now() - started).toBeLessThan(5_000);
    await runner.waitForIdle(task.id);
    expect(machine.getTask(task.id)?.state).toBe('CANCELLED');
  }, 30_000);

  it('answers a quick question directly, without a planner session', async () => {
    const { runner, machine, workspace, store, queries } = await setup();
    const task = await runner.create({ workspaceId: workspace.id, objective: 'what is this folder about?', plan: true, agentId: 'opencode' });
    await runner.waitForIdle(task.id);
    expect(machine.getTask(task.id)?.state).toBe('COMPLETED');
    const details = queries.details(task.id);
    expect(details.plan).toBeNull();
    expect(details.steps.map((s) => s.assignedAdapterId)).toEqual(['opencode']);
    const sessions = store.db.prepare('SELECT COUNT(*) AS n FROM agent_sessions WHERE task_id = ?').get(task.id) as { n: number };
    expect(sessions.n).toBe(1);
    expect(details.events.some((e) => JSON.stringify(e.payload).includes('answers it directly'))).toBe(true);
  }, 30_000);

  it('rejects plan mode without an available planner', async () => {
    const { runner, workspace } = await setup();
    await expect(runner.create({ workspaceId: workspace.id, objective: 'x', plan: true })).rejects.toThrow('Choose the agent');
    await expect(runner.create({ workspaceId: workspace.id, objective: 'x', plan: true, agentId: 'codex' })).rejects.toThrow('not available');
  });
});
