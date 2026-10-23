import { AUTOMATION_SCHEMAS as S, type WorkflowHistoryRun, type WorkflowHistoryStep, type WorkflowStartInput } from '@shared/automation-contract';
import type { DagWorkflow, Task, TaskState, WorkflowTestReport, WorkflowStepHistoryEntry } from '@shared/domain';
import type { Store } from '../db/types';
import type { SkillsService, UpsertSkillInput, SaveSkillBindingInput, SetSkillBindingStatusInput, RemoveSkillBindingInput, SkillBindingFilter, SkillUsageFilter } from '../domain/skills-service';
import type { WorkflowEngine, SaveWorkflowInput } from '../orchestrator/workflow-engine';
import type { IpcRouter } from './router';
export interface AutomationHandlerDeps {
  router: IpcRouter; store: Store; workflows: WorkflowEngine; skills: SkillsService;
  startWorkflow?: (input: WorkflowStartInput) => Promise<Task>;
  testWorkflow?: (input: WorkflowStartInput) => Promise<WorkflowTestReport>;
}
export function registerAutomationHandlers({ router, store, workflows, skills, startWorkflow, testWorkflow }: AutomationHandlerDeps): void {
  router.handle('workflow.list', S['workflow.list'], (): DagWorkflow[] => {
    const rows = store.db.prepare(`SELECT definition FROM workflows w WHERE version = (SELECT MAX(version) FROM workflows h WHERE h.workflow_id = w.workflow_id) ORDER BY name COLLATE NOCASE`).all() as { definition: string }[];
    return rows.map(row => JSON.parse(row.definition) as DagWorkflow);
  });
  router.handle('workflow.get', S['workflow.get'], (_e, i) => workflows.get(i.workflowId, i.version));
  router.handle('workflow.save', S['workflow.save'], (_e, i) => workflows.save(i as SaveWorkflowInput));
  router.handle('workflow.versions', S['workflow.versions'], (_e, i) => workflows.listVersions(i.workflowId));
  router.handle('workflow.history', S['workflow.history'], (_e, i): WorkflowHistoryRun[] => {
    const runs = store.db.prepare('SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT 100').all(i.workflowId) as { id: string; workflow_id: string; version: number; status: WorkflowHistoryRun['status']; started_at: string; ended_at: string }[];
    const engineHistory: WorkflowHistoryRun[] = runs.map(run => ({ id: run.id, workflowId: run.workflow_id, version: run.version, status: run.status, startedAt: run.started_at, endedAt: run.ended_at,
      history: store.db.prepare(`SELECT step_id AS stepId, iteration, started_at AS startedAt, ended_at AS endedAt, outcome, attempts, recovery_action AS recoveryAction, detail FROM workflow_step_history WHERE run_id = ? ORDER BY ordinal`).all(run.id) as WorkflowStepHistoryEntry[],
    }));
    const tasks = store.db.prepare(`SELECT t.id, t.state, t.created_at, t.updated_at, w.version
      FROM workflow_tasks w JOIN tasks t ON t.id = w.task_id
      WHERE w.workflow_id = ? ORDER BY t.created_at DESC LIMIT 100`).all(i.workflowId) as { id: string; state: TaskState; created_at: string; updated_at: string; version: number }[];
    const taskHistory: WorkflowHistoryRun[] = tasks.map(task => ({
      id: task.id, taskId: task.id, workflowId: i.workflowId, version: task.version,
      status: task.state === 'COMPLETED' ? 'completed' : task.state === 'FAILED' ? 'failed'
        : task.state === 'CANCELLED' ? 'aborted' : task.state === 'WAITING_FOR_APPROVAL' ? 'waiting_for_approval'
        : task.state === 'BLOCKED' || task.state === 'RECOVERABLE_INTERRUPTION' ? 'blocked' : 'running',
      startedAt: task.created_at,
      endedAt: ['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.state) ? task.updated_at : null,
      history: (store.db.prepare(`SELECT id AS stepId, started_at AS startedAt, ended_at AS endedAt, status AS outcome,
        NULL AS attempts, NULL AS iteration, description AS detail FROM task_steps WHERE task_id = ? ORDER BY ordinal`).all(task.id) as WorkflowHistoryStep[]),
    }));
    return [...engineHistory, ...taskHistory].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 100);
  });
  router.handle('workflow.start', S['workflow.start'], (_e, i) => {
    workflows.get(i.workflowId, i.version);
    if (!startWorkflow) throw new Error('Workflow execution is unavailable: no task executor is connected.');
    return startWorkflow(i);
  });
  router.handle('workflow.test', S['workflow.test'], (_e, i) => {
    workflows.get(i.workflowId, i.version);
    if (!testWorkflow) throw new Error('Workflow execution tests are unavailable: no validation executor is connected.');
    return testWorkflow(i);
  });
  router.handle('skill.list', S['skill.list'], () => skills.list());
  router.handle('skill.get', S['skill.get'], (_e, i) => skills.get(i.skillId));
  router.handle('skill.save', S['skill.save'], (_e, i) => skills.upsert(i as UpsertSkillInput));
  router.handle('skill.versions', S['skill.versions'], (_e, i) => skills.versions(i.skillId));
  router.handle('skill.version', S['skill.version'], (_e, i) => skills.getVersion(i.skillId, i.version));
  router.handle('skill.rollback', S['skill.rollback'], (_e, i) => skills.rollback(i.skillId, i.version));
  router.handle('skill.export', S['skill.export'], (_e, i) => skills.exportTo(i.skillId, { agentId: i.agentId, format: i.format }));
  router.handle('skill.binding.list', S['skill.binding.list'], (_e, i) => skills.listBindings((i ?? {}) as SkillBindingFilter));
  router.handle('skill.binding.save', S['skill.binding.save'], (_e, i) => skills.saveBinding(i as SaveSkillBindingInput));
  router.handle('skill.binding.setStatus', S['skill.binding.setStatus'], (_e, i) => skills.setBindingStatus(i as SetSkillBindingStatusInput));
  router.handle('skill.binding.remove', S['skill.binding.remove'], (_e, i) => skills.removeBinding(i as RemoveSkillBindingInput));
  router.handle('skill.usage.list', S['skill.usage.list'], (_e, i) => skills.listUsages((i ?? {}) as SkillUsageFilter));
}
