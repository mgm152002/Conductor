import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { ResumeService } from '@main/orchestrator/resume-service';
import { TaskRunner } from '@main/orchestrator/task-runner';
import { RecordingTaskEventEmitter } from '@main/orchestrator/event-emitter';
import { makeFakeAdapter } from '../fakes/fake-adapter';
import { AttachmentService } from '@main/attachments/attachment-service';
import { DiskManagedStorage } from '@main/storage/managed-storage';

let store: SqliteStore;
let workspaceId: string;
let permissions: PermissionService;
let registry: Registry;
let machine: TaskStateMachine;
let runner: TaskRunner;
let events: RecordingTaskEventEmitter;
let resumeService: ResumeService;
let root: string;
let attachments: AttachmentService;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'conductor-task-attachments-'));
  store = new SqliteStore(':memory:'); await store.migrate();
  const audit = new AuditLog(store);
  const workspaces = new WorkspaceService(store);
  workspaceId = workspaces.create({name:'Test',rootPath:root}).id;
  permissions = new PermissionService(store,audit); registry = new Registry();
  machine = new TaskStateMachine(store,audit); events = new RecordingTaskEventEmitter();
  const canceller = new TaskCanceller(store,machine,registry,audit);
  const orchestrator = new Orchestrator(store,machine,workspaces,canceller,audit,{registry,permissions,emitter:events,maxStepRetries:0});
  resumeService = new ResumeService(store,machine,orchestrator,canceller,audit);
  attachments = new AttachmentService(store, new DiskManagedStorage(join(root, 'blobs')));
  runner = new TaskRunner({store,orchestrator,stateMachine:machine,permissions,registry,audit,emitter:events,attachments});
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
function register(requiredPermissions: {kind:'command_exec'}[] = []) {
  const adapter = makeFakeAdapter({record:{id:'test-agent',capabilities:[{id:'objective.fulfill',title:'Task agent',inputSchema:{},outputSchema:{},streaming:true,cancellable:true,resumable:false,requiredPermissions}]}});
  registry.register(adapter); return adapter;
}

describe('application task lifecycle', () => {
  it('links task attachments in order and keeps their materialized copies available', async () => {
    const source = join(root, 'API_KEY=supersecret notes.md');
    writeFileSync(source, '# Reference\n\nPersistent input.');
    const attachment = (await attachments.ingest([source])).attachments[0]!;

    const task = await runner.create({
      workspaceId, objective: 'Use the reference', attachmentIds: [attachment.id],
    });
    await runner.waitForIdle(task.id);

    expect(attachments.listTask(task.id)).toEqual([expect.objectContaining({
      id: attachment.id, name: expect.stringContaining('[REDACTED]'), kind: 'markdown',
    })]);
    expect(JSON.stringify(attachments.listTask(task.id))).not.toContain('supersecret');
    const link = store.db.prepare('SELECT ordinal, materialized_path FROM task_attachments WHERE task_id=? AND attachment_id=?')
      .get(task.id, attachment.id) as { ordinal: number; materialized_path: string };
    expect(link.ordinal).toBe(0);
    expect(existsSync(link.materialized_path)).toBe(true);
  });

  it('drives a submitted task past planning to verification and publishes state', async () => {
    register();
    const task = await runner.create({workspaceId,objective:'Research the project',acceptanceCriteria:['Review the findings']});
    await runner.waitForIdle(task.id);
    expect(machine.getTask(task.id)?.state).toBe('FAILED'); // conservative verifier refuses unproven criteria
    expect(store.db.prepare('SELECT status FROM task_steps WHERE task_id=?').get(task.id)).toMatchObject({status:'succeeded'});
    expect(events.payloadsFor('task.updated').length).toBeGreaterThan(0);
  });
  it('surfaces unroutable work as BLOCKED with an actionable reason', async () => {
    const task = await runner.create({workspaceId,objective:'Research the project'});
    await runner.waitForIdle(task.id);
    expect(machine.getTask(task.id)?.state).toBe('BLOCKED');
    expect(machine.getTask(task.id)?.recommendedNextAction).toMatch(/agent|adapter|Connected apps/i);
  });
  it('enforces adapter permissions and approval exactly once before starting', async () => {
    register([{kind:'command_exec'}]);
    permissions.grant({subject:{type:'agent',id:'orchestrator'},profile:'assisted_execution'});
    const task = await runner.create({workspaceId,objective:'Research the project'});
    await runner.waitForIdle(task.id);
    expect(machine.getTask(task.id)?.state).toBe('WAITING_FOR_APPROVAL');
    const approval = permissions.pendingApprovals(task.id)[0]!;
    expect(approval).toBeDefined();
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM agent_sessions').get()).toEqual({n:0});
    await runner.resolveApproval({approvalId:approval.id,decision:'approved'});
    await runner.waitForIdle(task.id);
    expect(machine.getTask(task.id)?.state).not.toBe('WAITING_FOR_APPROVAL');
    await runner.resolveApproval({approvalId:approval.id,decision:'approved'});
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM agent_sessions').get()).toEqual({n:1});
  });
  it('uses persisted step permissions when resuming interrupted work', async () => {
    register([{kind:'command_exec'}]);
    permissions.grant({subject:{type:'agent',id:'orchestrator'},profile:'assisted_execution'});
    const task = await runner.create({workspaceId,objective:'Execute a command'});
    await runner.waitForIdle(task.id);
    machine.transition({taskId:task.id,to:'RECOVERABLE_INTERRUPTION'});
    const result = await resumeService.act({taskId:task.id,action:'resume'});
    expect(result.status).toBe('confirmation_required');
    expect(machine.getTask(task.id)?.state).toBe('RECOVERABLE_INTERRUPTION');
  });
  it('requires a fresh approval after the previous grant is revoked and replaced', async () => {
    register([{kind:'command_exec'}]);
    const subject = {type:'agent' as const,id:'orchestrator'};
    permissions.grant({subject,profile:'assisted_execution'});
    const task = await runner.create({workspaceId,objective:'Execute a command'});
    await runner.waitForIdle(task.id);
    const previous = permissions.pendingApprovals(task.id)[0]!;
    permissions.approve(previous.id);
    permissions.revoke({subject});
    permissions.grant({subject,profile:'assisted_execution'});
    runner.drive(task.id); await runner.waitForIdle(task.id);
    expect(machine.getTask(task.id)?.state).toBe('WAITING_FOR_APPROVAL');
    expect(permissions.pendingApprovals(task.id)[0]?.id).not.toBe(previous.id);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM agent_sessions').get()).toEqual({n:0});
  });
  it('denial cancels the task without starting an adapter', async () => {
    register([{kind:'command_exec'}]);
    permissions.grant({subject:{type:'agent',id:'orchestrator'},profile:'assisted_execution'});
    const task = await runner.create({workspaceId,objective:'Research the project'});
    await runner.waitForIdle(task.id);
    await runner.resolveApproval({approvalId:permissions.pendingApprovals(task.id)[0]!.id,decision:'denied'});
    expect(machine.getTask(task.id)?.state).toBe('CANCELLED');
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM agent_sessions').get()).toEqual({n:0});
  });
});
