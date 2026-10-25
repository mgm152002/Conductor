import { z } from 'zod';
import type { AgentPlan, PlanTask, PlanWave } from '@shared/plan';

// The planner's output contract, its validation, the dependency waves and the
// two markdown documents (requirements.md, tasks.md). Pure functions only.

export const MAX_PLAN_TASKS = 12;

const id = z.union([z.string(), z.number()]).transform((v) => String(v).trim());
const text = (max: number) => z.string().trim().min(1).max(max);

const RawTask = z.object({
  id,
  title: text(200),
  details: z.array(z.string().trim().max(600)).max(12).optional().default([]),
  requirements: z.array(id).max(20).optional().default([]),
  dependsOn: z.array(id).max(MAX_PLAN_TASKS).optional().default([]),
  agent: z.string().trim().max(80).optional(),
  difficulty: z.string().trim().toLowerCase().optional(),
});

const DIFFICULTIES = ['simple', 'moderate', 'complex'] as const;

const RawPlan = z.object({
  title: text(200),
  introduction: z.string().trim().max(4000).optional().default(''),
  requirements: z.array(z.object({
    id,
    title: text(200),
    userStory: z.string().trim().max(1500).optional(),
    acceptanceCriteria: z.array(text(800)).min(1).max(15),
  })).min(1).max(20),
  groups: z.array(z.object({ id, title: text(200), tasks: z.array(RawTask).min(1).max(MAX_PLAN_TASKS) })).min(1).max(10),
});

export class PlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanValidationError';
  }
}

/** The JSON object in the planner's reply: the last ```json block, else the outermost braces. */
export function extractPlanJson(reply: string): unknown {
  const fenced = [...reply.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]!).filter((block) => block.trim().startsWith('{'));
  const candidates = fenced.length > 0 ? fenced.reverse() : [];
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start !== -1 && end > start) candidates.push(reply.slice(start, end + 1));
  for (const candidate of candidates) {
    try { return JSON.parse(candidate) as unknown; } catch { /* try the next one */ }
  }
  throw new PlanValidationError('The planner did not reply with a JSON plan.');
}

/**
 * A plan task whose requested agent is not available, reported so the planner
 * can explain the reassignment in the thread.
 */
export interface PlanAgentFallback {
  readonly planTaskId: string;
  readonly title: string;
  readonly requestedAgent: string;
}

/**
 * Validate a raw plan: shape, unique task ids, known dependencies, no cycles,
 * at most MAX_PLAN_TASKS tasks. Unknown or unavailable agents become the
 * fallback agent (the most preferred available one).
 */
export function validatePlan(
  raw: unknown,
  agents: ReadonlySet<string>,
  fallbackAgentId: string,
  onAgentFallback?: (fallback: PlanAgentFallback) => void,
): AgentPlan {
  const parsed = RawPlan.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PlanValidationError(`The plan is malformed${issue ? ` at ${issue.path.join('.') || 'top level'}: ${issue.message}` : ''}.`);
  }
  const plan = parsed.data;
  const tasks = plan.groups.flatMap((g) => g.tasks);
  if (tasks.length > MAX_PLAN_TASKS) throw new PlanValidationError(`The plan has ${tasks.length} tasks; the limit is ${MAX_PLAN_TASKS}.`);
  const ids = new Set<string>();
  for (const task of tasks) {
    if (!/^[\w.-]{1,20}$/.test(task.id)) throw new PlanValidationError(`Task id "${task.id}" is not valid.`);
    if (ids.has(task.id)) throw new PlanValidationError(`Task id ${task.id} is used twice.`);
    ids.add(task.id);
  }
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (dep === task.id) throw new PlanValidationError(`Task ${task.id} depends on itself.`);
      if (!ids.has(dep)) throw new PlanValidationError(`Task ${task.id} depends on unknown task ${dep}.`);
    }
  }
  const result: AgentPlan = {
    title: plan.title,
    introduction: plan.introduction,
    requirements: plan.requirements.map((r) => ({ id: r.id, title: r.title, ...(r.userStory ? { userStory: r.userStory } : {}), acceptanceCriteria: r.acceptanceCriteria })),
    groups: plan.groups.map((g) => ({
      id: g.id, title: g.title,
      tasks: g.tasks.map((t): PlanTask => {
        const available = t.agent !== undefined && agents.has(t.agent);
        if (t.agent !== undefined && !available) {
          onAgentFallback?.({ planTaskId: t.id, title: t.title, requestedAgent: t.agent });
        }
        return {
          id: t.id, title: t.title, details: t.details.filter((d) => d !== ''), requirements: t.requirements,
          dependsOn: [...new Set(t.dependsOn)], agent: available ? t.agent! : fallbackAgentId,
          difficulty: (DIFFICULTIES as readonly string[]).includes(t.difficulty ?? '') ? t.difficulty as PlanTask['difficulty'] : 'moderate',
        };
      }),
    })),
  };
  computeWaves(result); // throws on a cycle
  return result;
}

export function planTasks(plan: AgentPlan): PlanTask[] {
  return plan.groups.flatMap((g) => g.tasks);
}

/** Wave n holds the tasks whose dependencies all sit in waves < n. Throws on a cycle. */
export function computeWaves(plan: AgentPlan): PlanWave[] {
  const tasks = planTasks(plan);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const level = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (taskId: string, path: string[]): number => {
    const known = level.get(taskId);
    if (known !== undefined) return known;
    if (visiting.has(taskId)) throw new PlanValidationError(`The plan's dependencies form a cycle: ${[...path, taskId].join(' → ')}.`);
    visiting.add(taskId);
    const deps = byId.get(taskId)?.dependsOn ?? [];
    const value = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((d) => visit(d, [...path, taskId])));
    visiting.delete(taskId);
    level.set(taskId, value);
    return value;
  };
  for (const task of tasks) visit(task.id, []);
  const waves: PlanWave[] = [];
  for (const task of tasks) {
    const n = level.get(task.id)!;
    while (waves.length <= n) waves.push({ id: waves.length, tasks: [] });
    waves[n]!.tasks.push(task.id);
  }
  return waves;
}

/** The waves JSON block, formatted one wave per line. */
export function wavesJson(waves: PlanWave[]): string {
  const lines = waves.map((w) => `    { "id": ${w.id}, "tasks": [${w.tasks.map((t) => JSON.stringify(t)).join(', ')}] }`);
  return `{\n  "waves": [\n${lines.join(',\n')}\n  ]\n}`;
}

export function renderRequirements(plan: AgentPlan, objective: string): string {
  const out = [`# Requirements: ${plan.title}`, '', '## Introduction', '', plan.introduction || objective, '', '## Requirements', ''];
  for (const req of plan.requirements) {
    out.push(`### Requirement ${req.id}: ${req.title}`, '');
    if (req.userStory) out.push(`**User story:** ${req.userStory}`, '');
    out.push('#### Acceptance criteria', '');
    req.acceptanceCriteria.forEach((c, i) => { out.push(`${i + 1}. ${c}`); });
    out.push('');
  }
  return out.join('\n');
}

export type PlanTaskStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';

/** tasks.md in the Kiro spec layout, with checkboxes reflecting each task's status. */
export function renderTasks(plan: AgentPlan, input: {
  objective: string; plannerName: string; agentName: (id: string) => string; status?: (taskId: string) => PlanTaskStatus | undefined;
}): string {
  const waves = computeWaves(plan);
  const mark = (s: PlanTaskStatus | undefined): string => (s === 'succeeded' ? 'x' : s === 'running' ? '-' : ' ');
  const note = (s: PlanTaskStatus | undefined): string => (s === 'failed' ? ' _(failed)_' : s === 'skipped' ? ' _(skipped)_' : s === 'cancelled' ? ' _(stopped)_' : '');
  const out = [
    `# Implementation Plan: ${plan.title}`, '', '## Overview', '',
    `Planned by ${input.plannerName} for: ${input.objective.replace(/\s+/g, ' ').slice(0, 500)}`, '',
    'Each task runs on the agent shown. Tasks in the same wave of the dependency graph have no dependencies on each other and run in parallel.', '',
    '## Tasks', '',
  ];
  for (const group of plan.groups) {
    const statuses = group.tasks.map((t) => input.status?.(t.id));
    out.push(`- [${statuses.every((s) => s === 'succeeded') ? 'x' : ' '}] ${group.id}. ${group.title}`);
    group.tasks.forEach((task, i) => {
      const status = statuses[i];
      out.push(`  - [${mark(status)}] ${task.id} ${task.title}${note(status)}`);
      for (const detail of task.details) out.push(`    - ${detail}`);
      if (task.dependsOn.length > 0) out.push(`    - _Depends on: ${task.dependsOn.join(', ')}_`);
      if (task.requirements.length > 0) out.push(`    - _Requirements: ${task.requirements.join(', ')}_`);
      out.push(`    - _Agent: ${input.agentName(task.agent)} · ${task.difficulty}_`);
    });
    out.push('');
  }
  out.push('## Task Dependency Graph', '', '```json', wavesJson(waves), '```', '');
  return out.join('\n');
}

/** "2026-10-24-add-dark-mode": a folder name for the plan documents. */
export function planSlug(title: string, date: Date): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '') || 'plan';
  return `${date.toISOString().slice(0, 10)}-${slug}`;
}

/** The criteria text a task's requirement references point at. */
export function referencedCriteria(plan: AgentPlan, task: PlanTask): string[] {
  const out: string[] = [];
  for (const ref of task.requirements) {
    const [reqId, index] = ref.split('.');
    const req = plan.requirements.find((r) => r.id === reqId);
    if (req === undefined) continue;
    if (index === undefined) out.push(...req.acceptanceCriteria.map((c, i) => `${req.id}.${i + 1} ${c}`));
    else {
      const criterion = req.acceptanceCriteria[Number(index) - 1];
      if (criterion !== undefined) out.push(`${ref} ${criterion}`);
    }
  }
  return [...new Set(out)];
}
