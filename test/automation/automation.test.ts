import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { SqliteStore } from '@main/db/store';
import { AuditLog } from '@main/domain/audit-log';
import { SkillsService } from '@main/domain/skills-service';
import { WorkflowEngine } from '@main/orchestrator/workflow-engine';
import { registerAutomationHandlers } from '@main/ipc/register-automation';
import { IpcRouter } from '@main/ipc/router';
import { AUTOMATION_SCHEMAS } from '@shared/automation-contract';
import type { InvoiceExtractionTemplate, SkillVersionBody } from '@shared/domain';

const body: SkillVersionBody = {
  purpose: 'Review code', applicability: 'During review', requiredContext: ['diff'],
  inputContract: [], outputContract: [], steps: [{ instruction: 'Read diff', constraints: [] }],
  toolRequirements: ['filesystem.read'], failureHandling: 'Report missing context',
  verificationCriteria: ['Findings reference lines'], examples: [{ title: 'empty diff', input: '', expectedOutput: [] }],
};
let dir: string;
let store: SqliteStore;
let skills: SkillsService;
let handlers: Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>>;
const invoke = async (channel: string, input?: unknown) => handlers.get(channel)!({} as IpcMainInvokeEvent, input) as Promise<any>;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'conductor-automation-'));
  store = new SqliteStore(join(dir, 'app.db'));
  await store.migrate();
  handlers = new Map();
  const ipcMain = { handle(channel: string, handler: (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>) {
    handlers.set(channel, handler);
  } } as unknown as IpcMain;
  const router = new IpcRouter({ ipcMain });
  skills = new SkillsService(store, new AuditLog(store));
  registerAutomationHandlers({ router, store, workflows: new WorkflowEngine(store), skills });
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe('automation IPC', () => {
  it('registers every automation channel through the shared allowlist', () => {
    expect([...handlers.keys()].sort()).toEqual(Object.keys(AUTOMATION_SCHEMAS).sort());
  });
  it('rejects invalid step policies and missing skill fields before persisting', async () => {
    const invalid = await invoke('workflow.save', { name: 'bad', steps: [{ id: 'a', description: 'a', requiredCapability: 'x', dependsOn: [], policy: { maxRetries: -1, timeoutMs: 0 } }] });
    expect(invalid.ok).toBe(false);
    expect(invalid.error.code).toBe('validation_failed');
    expect((await invoke('workflow.list')).value).toEqual([]);
    expect(AUTOMATION_SCHEMAS['skill.save'].safeParse({ name: 'bad', scope: 'global', body: {}, provenance: { method: 'user_authored', source: 'user' } }).success).toBe(false);
  });
  it('persists workflow versions, lists current definitions, and rejects cycles', async () => {
    const saved = (await invoke('workflow.save', { name: 'Review', steps: [{ id: 'a', description: 'read', requiredCapability: 'read', dependsOn: [] }] })).value;
    expect(saved.version).toBe(1);
    const next = await invoke('workflow.save', { workflowId: saved.workflowId, name: 'Review revised', steps: saved.steps });
    expect(next.value.version).toBe(2);
    expect((await invoke('workflow.list')).value.map((w: any) => w.name)).toEqual(['Review revised']);
    expect((await invoke('workflow.versions', { workflowId: saved.workflowId })).value).toHaveLength(2);
    const cycle = await invoke('workflow.save', { name: 'cycle', steps: [{ id: 'a', description: 'a', requiredCapability: 'read', dependsOn: ['a'] }] });
    expect(cycle.ok).toBe(false);
    expect((await invoke('workflow.list')).value).toHaveLength(1);
  });
  it('requires a diff confirmation, retains versions after rollback, then saves a new monotonic version', async () => {
    const input = { name: 'Review', scope: 'global', body, provenance: { method: 'user_authored', source: 'user' } };
    const created = (await invoke('skill.save', input)).value;
    const changed = { ...input, body: { ...body, purpose: 'Review carefully' } };
    const proposed = (await invoke('skill.save', changed)).value;
    expect(proposed.status).toBe('confirmation_required');
    expect(proposed.diff.entries[0].field).toBe('purpose');
    expect((await invoke('skill.get', { skillId: created.skillId })).value.body.purpose).toBe(body.purpose);
    expect((await invoke('skill.save', { ...changed, confirmed: true })).value.version).toBe(2);
    expect((await invoke('skill.rollback', { skillId: created.skillId, version: 1 })).value.currentVersion).toBe(1);
    const third = await invoke('skill.save', { ...changed, confirmed: true });
    expect(third.ok).toBe(true);
    expect(third.value.version).toBe(3);
    expect((await invoke('skill.versions', { skillId: created.skillId })).value).toEqual([1, 2, 3]);
  });
  it('includes task-backed workflow history without inventing pending step times or attempts', async () => {
    const saved = (await invoke('workflow.save', { name: 'Review', steps: [{ id: 'a', description: 'read', requiredCapability: 'read', dependsOn: [] }] })).value;
    const workspaceId = '550e8400-e29b-41d4-a716-446655440000';
    const taskId = '550e8400-e29b-41d4-a716-446655440001';
    store.db.prepare('INSERT INTO workspaces (id,name,root_path,created_at,updated_at) VALUES (?,?,?,?,?)').run(workspaceId,'Test','/test','2026-01-01','2026-01-01');
    store.db.prepare('INSERT INTO tasks (id,workspace_id,objective,state,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(taskId,workspaceId,'Review','WAITING_FOR_APPROVAL','2026-01-01','2026-01-01');
    store.db.prepare('INSERT INTO workflow_tasks (task_id,workflow_id,version) VALUES (?,?,?)').run(taskId,saved.workflowId,1);
    store.db.prepare('INSERT INTO task_steps (id,task_id,ordinal,description,status) VALUES (?,?,?,?,?)').run('step-a',taskId,0,'Read source','pending');
    const history = (await invoke('workflow.history', {workflowId:saved.workflowId})).value;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ taskId, status: 'waiting_for_approval', endedAt: null });
    expect(history[0].history[0]).toMatchObject({ outcome: 'pending', startedAt: null, endedAt: null, attempts: null });
  });
  it('exports complete markdown instructions including input/output contracts and examples', async () => {
    const created = (await invoke('skill.save', { name: 'Review', scope: 'global', body: { ...body, inputContract: [{ name: 'diff', description: 'Source diff', required: true }], outputContract: [{ name: 'findings', description: 'Review findings', required: true }] }, provenance: { method: 'user_authored', source: 'user' } })).value;
    const exported = (await invoke('skill.export', { skillId: created.skillId, agentId: 'portable-file', format: 'markdown' })).value;
    expect(exported.status).toBe('exported');
    expect(exported.content).toContain('Source diff');
    expect(exported.content).toContain('Review findings');
    expect(exported.content).toContain('empty diff');
    expect(exported.content).toContain('Expected output');
  });
  it('never reports a fake workflow execution or test when no real executor is wired', async () => {
    const saved = (await invoke('workflow.save', { name: 'Review', steps: [{ id: 'a', description: 'read', requiredCapability: 'read', dependsOn: [] }] })).value;
    const request = { workflowId: saved.workflowId, workspaceId: '550e8400-e29b-41d4-a716-446655440000' };
    expect((await invoke('workflow.start', request)).ok).toBe(false);
    expect((await invoke('workflow.test', request)).ok).toBe(false);
    expect((await invoke('workflow.history', { workflowId: saved.workflowId })).value).toEqual([]);
  });

  const template: InvoiceExtractionTemplate = {
    fields: [{ name: 'total', labels: ['Total Due'], required: true, normalization: 'amount' }],
    lineItems: { columns: [{ field: 'description', labels: ['Description'], required: true }] },
  };
  const createInvoiceSkill = async (purpose = 'Extract vendor invoice fields') =>
    (await invoke('skill.save', {
      name: 'Invoice parsing', scope: 'global',
      body: { ...body, purpose }, provenance: { method: 'agent_output', source: 'open-code' },
    })).value as { skillId: string };

  it('creates, lists, disables, and removes vendor bindings through IPC', async () => {
    const created = await createInvoiceSkill();
    const saved = await invoke('skill.binding.save', {
      skillId: created.skillId,
      trigger: { kind: 'vendor', key: 'V-1001', aliases: ['Vendor 1001'] },
      extractionTemplate: template,
      actor: 'orchestrator',
    });
    expect(saved.ok).toBe(true);
    expect(saved.value.trigger.key).toBe('v 1001');
    expect(saved.value.status).toBe('active');

    expect((await invoke('skill.binding.list')).value).toHaveLength(1);
    expect((await invoke('skill.binding.list', { status: 'active' })).value).toHaveLength(1);
    expect((await invoke('skill.binding.list', { status: 'disabled' })).value).toEqual([]);

    const disabled = await invoke('skill.binding.setStatus', { bindingId: saved.value.id, status: 'disabled' });
    expect(disabled.value.status).toBe('disabled');
    expect((await invoke('skill.binding.list', { status: 'active' })).value).toEqual([]);

    expect((await invoke('skill.binding.remove', { bindingId: saved.value.id })).ok).toBe(true);
    expect((await invoke('skill.binding.list')).value).toEqual([]);
  });

  it('rejects invalid binding triggers and templates before persisting', async () => {
    const created = await createInvoiceSkill();
    const invalidTrigger = await invoke('skill.binding.save', {
      skillId: created.skillId,
      trigger: { kind: 'vendor', key: '   ' },
      extractionTemplate: template,
    });
    expect(invalidTrigger.ok).toBe(false);
    expect(invalidTrigger.error.code).toBe('validation_failed');

    const invalidTemplate = await invoke('skill.binding.save', {
      skillId: created.skillId,
      trigger: { kind: 'vendor', key: 'V-1001' },
      extractionTemplate: { fields: [] },
    });
    expect(invalidTemplate.ok).toBe(false);
    expect((await invoke('skill.binding.list')).value).toEqual([]);
  });

  it('lists attributed usage over IPC and resolves bindings to the rolled-back head', async () => {
    const created = await createInvoiceSkill();
    const binding = (await invoke('skill.binding.save', {
      skillId: created.skillId,
      trigger: { kind: 'vendor', key: 'V-1001' },
      extractionTemplate: template,
    })).value;
    const taskId = '550e8400-e29b-41d4-a716-446655440021';
    const workspaceId = '550e8400-e29b-41d4-a716-446655440020';
    store.db.prepare('INSERT INTO workspaces (id,name,root_path,created_at,updated_at) VALUES (?,?,?,?,?)')
      .run(workspaceId, 'Test', '/test', '2026-01-01', '2026-01-01');
    store.db.prepare('INSERT INTO tasks (id,workspace_id,objective,state,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run(taskId, workspaceId, 'Parse invoice', 'COMPLETED', '2026-01-01', '2026-01-01');

    const usage = skills.recordUsage({ bindingId: binding.id, taskId });
    expect(skills.matchBinding({ kind: 'vendor', key: 'v-1001' })?.skill.currentVersion).toBe(1);

    const updated = await invoke('skill.save', {
      name: 'Invoice parsing', scope: 'global',
      body: { ...body, purpose: 'Extract invoice fields carefully' },
      provenance: { method: 'agent_output', source: 'open-code' }, confirmed: true,
    });
    expect(updated.value.version).toBe(2);
    expect(skills.matchBinding({ kind: 'vendor', key: 'v-1001' })?.skill.currentVersion).toBe(2);
    await invoke('skill.rollback', { skillId: created.skillId, version: 1 });
    expect(skills.matchBinding({ kind: 'vendor', key: 'v-1001' })?.skill.currentVersion).toBe(1);

    skills.finishUsage(usage.id, 'completed');
    const listed = (await invoke('skill.usage.list', { taskId })).value;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      taskId, skillId: created.skillId, skillVersion: 1, triggerKey: 'v 1001', outcome: 'completed',
    });
  });
});
