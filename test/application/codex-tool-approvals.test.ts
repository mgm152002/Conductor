import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { evidenceEvaluator } from '@main/orchestrator/evidence-evaluator';
import { RecordingTaskEventEmitter } from '@main/orchestrator/event-emitter';
import { ToolApprovalBroker } from '@main/orchestrator/tool-approvals';
import { replyFor, codexSessionId } from '@main/orchestrator/thread-context';
import { approvalPolicyFor, execItem } from '@main/adapters/codex-app-server-adapter';

const FIXTURE = resolve(__dirname, '../fixtures/codex-app-server-fixture.mjs');
let root: string | undefined;
let store: SqliteStore | undefined;
afterEach(() => { store?.close(); if (root) rmSync(root, { recursive: true, force: true }); });

async function setup() {
  root = mkdtempSync(join(tmpdir(), 'conductor-appserver-'));
  const binary = join(root, 'codex');
  writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" "$@"\n`);
  chmodSync(binary, 0o755);
  store = new SqliteStore(':memory:');
  await store.migrate();
  const s = store;
  const workspaces = new WorkspaceService(s);
  const workspace = workspaces.create({ name: 'W', rootPath: root });
  const audit = new AuditLog(s);
  const permissions = new PermissionService(s, audit);
  permissions.grant({ subject: { type: 'agent', id: 'orchestrator' }, profile: 'assisted_execution' });
  const registry = new Registry();
  const changes: string[] = [];
  const broker = new ToolApprovalBroker(s, permissions, (taskId) => { changes.push(taskId); });
  new CliRegistrar(registry, undefined, undefined, (request, signal) => broker.request(request, signal))
    .ensureRegistered({ id: 'codex', displayName: 'Codex', candidateBinaryNames: [binary], installMethod: { kind: 'unconfigured' } }, binary);
  const machine = new TaskStateMachine(s, audit);
  const canceller = new TaskCanceller(s, machine, registry, audit);
  const emitter = new RecordingTaskEventEmitter();
  const rootPath = root;
  const orchestrator = new Orchestrator(s, machine, workspaces, canceller, audit, {
    registry, permissions, emitter, maxStepRetries: 0, criterionEvaluator: evidenceEvaluator(s),
    executionInput: (task) => ({ objective: task.objective, rootPath, mode: 'assisted_execution' }),
  });
  const runner = new TaskRunner({ store: s, orchestrator, stateMachine: machine, permissions, registry, audit, emitter, toolApprovals: broker });
  return { s, runner, machine, permissions, workspace, broker, changes };
}

async function waitForApproval(permissions: PermissionService, taskId: string) {
  for (let i = 0; i < 200; i += 1) {
    const pending = permissions.pendingApprovals(taskId);
    if (pending.length > 0) return pending[0]!;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('no approval requested');
}

describe('Codex over app-server with per-tool-call approvals', () => {
  it('starts without an up-front approval and asks only when Codex runs a command', async () => {
    const { s, runner, machine, permissions, workspace } = await setup();
    const task = await runner.create({ workspaceId: workspace.id, objective: 'make notes', acceptanceCriteria: ['contains: decision=accept'] });
    const approval = await waitForApproval(permissions, task.id);
    // The task is already running Codex; the request is for the specific command.
    expect(machine.getTask(task.id)?.state).toBe('RUNNING');
    expect(approval.summary).toContain('Codex wants to run a command');
    expect(approval.summary).toContain('touch notes.txt');
    expect(approval.requirements).toEqual([{ kind: 'command_exec', scope: 'touch notes.txt' }]);

    await runner.resolveApproval({ approvalId: approval.id, decision: 'approved' });
    await runner.waitForIdle(task.id);
    expect(machine.getTask(task.id)?.state).toBe('COMPLETED');
    // Fell back from the rejected default model to one the account offers.
    expect(replyFor(s, task.id)).toBe('decision=accept model=gpt-good prompt=make notes');
    expect(codexSessionId(s, task.id)).toBe('0b9c3d1e-7a2f-4c1b-9e8d-aaaaaaaaaaaa');
  }, 30_000);

  it('declines only that action when the user denies it; the task continues', async () => {
    const { s, runner, machine, permissions, workspace } = await setup();
    const task = await runner.create({ workspaceId: workspace.id, objective: 'make notes', acceptanceCriteria: ['contains: decision=decline'] });
    const approval = await waitForApproval(permissions, task.id);
    await runner.resolveApproval({ approvalId: approval.id, decision: 'denied' });
    await runner.waitForIdle(task.id);
    expect(machine.getTask(task.id)?.state).toBe('COMPLETED');
    expect(replyFor(s, task.id)).toContain('decision=decline');
  }, 30_000);

  it('expires an open tool approval when the task is cancelled', async () => {
    const { runner, permissions, workspace, machine } = await setup();
    const task = await runner.create({ workspaceId: workspace.id, objective: 'make notes' });
    const approval = await waitForApproval(permissions, task.id);
    await machine; // keep reference
    await (runner as unknown as { deps: { orchestrator: Orchestrator } }).deps.orchestrator.cancelTask(task.id);
    await runner.waitForIdle(task.id);
    expect(permissions.getApproval(approval.id)?.status).toBe('expired');
    expect(machine.getTask(task.id)?.state).toBe('CANCELLED');
  }, 30_000);
});

describe('app-server mapping', () => {
  it('maps profiles to sandbox and approval policy', () => {
    expect(approvalPolicyFor('read_only')).toEqual({ sandbox: 'read-only', approvalPolicy: 'never' });
    expect(approvalPolicyFor('assisted_execution')).toEqual({ sandbox: 'workspace-write', approvalPolicy: 'untrusted' });
    expect(approvalPolicyFor('trusted_automation')).toEqual({ sandbox: 'workspace-write', approvalPolicy: 'never' });
    expect(approvalPolicyFor('read_only', true)).toEqual({ sandbox: 'workspace-write', approvalPolicy: 'untrusted' });
  });
  it('translates items to the exec JSONL shape', () => {
    expect(execItem({ type: 'agentMessage', id: 'a', text: 'hi' })).toEqual({ id: 'a', type: 'agent_message', text: 'hi' });
    expect(execItem({ type: 'commandExecution', id: 'c', command: 'ls', status: 'completed', exitCode: 0, aggregatedOutput: 'x' }))
      .toEqual({ id: 'c', type: 'command_execution', command: 'ls', aggregated_output: 'x', exit_code: 0, status: 'completed' });
    expect(execItem({ type: 'fileChange', id: 'f', status: 'completed', changes: [{ path: 'a.ts', kind: { type: 'add' } }] }))
      .toEqual({ id: 'f', type: 'file_change', status: 'completed', changes: [{ path: 'a.ts', kind: 'add' }] });
  });
});
