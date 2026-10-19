import { z } from 'zod';
import type { DagWorkflow, Skill, SkillBinding, SkillExportResult, SkillUpdateResult, SkillUsage, SkillVersion, SkillWithBody, Task, TaskStepStatus, WorkflowRunResult, WorkflowStepHistoryEntry, WorkflowTestReport } from './domain';
import { InvoiceExtractionTemplateSchema } from './skill-draft';

const text = z.string().trim().min(1);
const id = z.string().uuid();
const version = z.number().int().positive();
const json: z.ZodType<unknown> = z.lazy(() => z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(json), z.record(z.string(), json)]));
const recovery = z.object({ kind: z.enum(['abort', 'continue', 'compensate']), compensateWith: text.optional() }).refine(value => value.kind !== 'compensate' || !!value.compensateWith, { message: 'Compensation requires a target step', path: ['compensateWith'] });
const workflowKey = z.object({ workflowId: id, version: version.optional() });
export const WorkflowSaveSchema = z.object({
  workflowId: id.optional(), name: text.max(255),
  triggers: z.array(z.object({ kind: z.enum(['manual', 'scheduled', 'event']), config: json.optional() })).optional(),
  inputSchema: json.optional(), outputSchema: json.optional(), requiredContext: z.array(text).optional(),
  steps: z.array(z.object({
    id: text, description: text, requiredCapability: text, dependsOn: z.array(text),
    requiredPermissions: z.array(z.object({ kind: z.enum(['filesystem_read', 'filesystem_write', 'command_exec', 'network_egress', 'external_comm', 'financial', 'destructive']), scope: text.optional() })).optional(),
    loop: z.object({ continueWhile: text, maxIterations: z.number().int().min(1).max(1000) }).optional(),
    branch: z.object({ expression: text, whenTrue: z.array(text), whenFalse: z.array(text) }).optional(),
    policy: z.object({ maxRetries: z.number().int().min(0).max(100), timeoutMs: z.number().int().min(1).max(3600000) }).optional(),
    requiresApproval: z.boolean().optional(), errorRecovery: recovery.optional(),
  })).min(1).max(500),
  validationCriteria: z.array(z.object({ id: text, description: text })).optional(),
  errorRecovery: recovery.optional(), memoryUpdates: z.array(z.object({ layer: text, key: text, value: json })).optional(),
});
const io = z.array(z.object({ name: text, description: z.string(), required: z.boolean(), schema: json.optional() }));
export const SkillBodySchema = z.object({
  purpose: text, applicability: text, requiredContext: z.array(text).min(1), inputContract: io, outputContract: io,
  steps: z.array(z.object({ instruction: text, constraints: z.array(text) })).min(1), toolRequirements: z.array(text).min(1),
  failureHandling: text, verificationCriteria: z.array(text).min(1),
  examples: z.array(z.object({ title: text, input: json, expectedOutput: json })).min(1),
});
export const SkillSaveSchema = z.object({
  name: text.max(255), scope: z.enum(['global', 'project', 'workflow']), scopeRef: text.optional(),
  body: SkillBodySchema, provenance: z.object({ method: z.enum(['user_authored', 'agent_output', 'inferred']), source: text }),
  confirmed: z.boolean().optional(),
}).refine(value => value.scope === 'global' || !!value.scopeRef, { message: 'Project and workflow scopes require a scope reference', path: ['scopeRef'] });

const bindingStatus = z.enum(['active', 'disabled']);
const skillTrigger = z.object({
  kind: z.literal('vendor'),
  key: text.max(255),
  aliases: z.array(text.max(255)).max(32).default([]),
});
export const SkillBindingSaveSchema = z.object({
  bindingId: id.optional(),
  skillId: id,
  trigger: skillTrigger,
  extractionTemplate: InvoiceExtractionTemplateSchema,
  status: bindingStatus.optional(),
  actor: text.max(255).optional(),
  sourceTaskId: id.optional(),
});
export const SkillBindingListSchema = z.object({
  skillId: id.optional(),
  status: bindingStatus.optional(),
}).optional();
export const SkillBindingSetStatusSchema = z.object({
  bindingId: id,
  status: bindingStatus,
  actor: text.max(255).optional(),
  sourceTaskId: id.optional(),
});
export const SkillBindingRemoveSchema = z.object({
  bindingId: id,
  actor: text.max(255).optional(),
  sourceTaskId: id.optional(),
});
export const SkillUsageListSchema = z.object({
  skillId: id.optional(),
  bindingId: id.optional(),
  taskId: id.optional(),
  limit: z.number().int().min(1).max(500).optional(),
}).optional();
export const WorkflowStartSchema = workflowKey.extend({ workspaceId: id, variables: z.record(z.string(), json).optional() });
export const AUTOMATION_SCHEMAS = {
  'workflow.list': z.void(), 'workflow.get': workflowKey, 'workflow.save': WorkflowSaveSchema,
  'workflow.versions': z.object({ workflowId: id }), 'workflow.history': z.object({ workflowId: id }),
  'workflow.start': WorkflowStartSchema, 'workflow.test': WorkflowStartSchema,
  'skill.list': z.void(), 'skill.get': z.object({ skillId: id }), 'skill.save': SkillSaveSchema,
  'skill.versions': z.object({ skillId: id }), 'skill.version': z.object({ skillId: id, version }),
  'skill.rollback': z.object({ skillId: id, version }),
  'skill.export': z.object({ skillId: id, agentId: text, format: z.enum(['markdown', 'json']) }),
  'skill.binding.list': SkillBindingListSchema, 'skill.binding.save': SkillBindingSaveSchema,
  'skill.binding.setStatus': SkillBindingSetStatusSchema, 'skill.binding.remove': SkillBindingRemoveSchema,
  'skill.usage.list': SkillUsageListSchema,
} as const;
export type WorkflowSaveInput = z.infer<typeof WorkflowSaveSchema>;
export type WorkflowStartInput = z.infer<typeof WorkflowStartSchema>;
export type SkillSaveInput = z.infer<typeof SkillSaveSchema>;
export type SkillBindingSaveInput = z.infer<typeof SkillBindingSaveSchema>;
export type SkillBindingListInput = z.infer<typeof SkillBindingListSchema>;
export type SkillBindingSetStatusInput = z.infer<typeof SkillBindingSetStatusSchema>;
export type SkillBindingRemoveInput = z.infer<typeof SkillBindingRemoveSchema>;
export type SkillUsageListInput = z.infer<typeof SkillUsageListSchema>;
export interface WorkflowHistoryStep extends Omit<WorkflowStepHistoryEntry, 'startedAt' | 'endedAt' | 'outcome' | 'attempts' | 'iteration'> {
  startedAt: string | null; endedAt: string | null;
  outcome: TaskStepStatus;
  attempts: number | null; iteration: number | null;
}
export interface WorkflowHistoryRun extends Omit<WorkflowRunResult, 'status' | 'history'> {
  id: string; taskId?: string; startedAt: string; endedAt: string | null;
  status: WorkflowRunResult['status'] | 'running' | 'waiting_for_approval' | 'blocked';
  history: WorkflowHistoryStep[];
}
export interface AutomationBridge {
  workflows: {
    list(): Promise<DagWorkflow[]>;
    get(input: { workflowId: string; version?: number }): Promise<DagWorkflow>;
    save(input: WorkflowSaveInput): Promise<DagWorkflow>;
    versions(workflowId: string): Promise<DagWorkflow[]>;
    history(workflowId: string): Promise<WorkflowHistoryRun[]>;
    start(input: WorkflowStartInput): Promise<Task>;
    test(input: WorkflowStartInput): Promise<WorkflowTestReport>;
  };
  skills: {
    list(): Promise<Skill[]>;
    get(skillId: string): Promise<SkillWithBody | undefined>;
    save(input: SkillSaveInput): Promise<SkillUpdateResult>;
    versions(skillId: string): Promise<number[]>;
    version(input: { skillId: string; version: number }): Promise<SkillVersion | undefined>;
    rollback(input: { skillId: string; version: number }): Promise<SkillWithBody>;
    export(input: { skillId: string; agentId: string; format: 'markdown' | 'json' }): Promise<SkillExportResult>;
    listBindings(input?: SkillBindingListInput): Promise<SkillBinding[]>;
    saveBinding(input: SkillBindingSaveInput): Promise<SkillBinding>;
    setBindingStatus(input: SkillBindingSetStatusInput): Promise<SkillBinding>;
    removeBinding(input: SkillBindingRemoveInput): Promise<void>;
    listUsages(input?: SkillUsageListInput): Promise<SkillUsage[]>;
  };
}
