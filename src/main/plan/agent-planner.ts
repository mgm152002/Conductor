import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterStreamEvent } from '@shared/adapter';
import { compareAgentPreference, preferredAgent } from '@shared/agent-preference';
import type { Task } from '@shared/domain';
import type { AgentPlan, TaskPlanStatus, TaskPlanView } from '@shared/plan';
import type { Difficulty, ResolvedRun } from '@shared/agent-models';
import { assessDifficulty, economyGuidance } from '../agents/model-routing';
import type { Store } from '../db/types';
import type { Registry } from '../registry/registry';
import type { TaskEventEmitter } from '../orchestrator/event-emitter';
import { PlaceholderPlanner, type PlanDecomposition, type PlannedStep, type Planner, type PlanRequest } from '../orchestrator/planner';
import { isCodexProtocol } from '../orchestrator/thread-context';
import { responseText } from '../adapters/objective-cli-adapter';
import { classifyFailure, retryableOnAnotherAgent, tailLines, type FailureKind } from '../adapters/failure-classification';
import { usageFromEvent, type UsageRecorder } from '../usage/usage';
import { quotaFromEvent, type QuotaRecorder } from '../usage/quota';
import { computeWaves, extractPlanJson, MAX_PLAN_TASKS, planSlug, planTasks, referencedCriteria, renderRequirements, renderTasks, validatePlan, type PlanTaskStatus } from './plan-doc';

// Plan mode. A task created with a planner agent gets a task_plans row; when
// the orchestrator plans it, this planner runs that agent in read-only mode,
// asks it for requirements and a task list with dependencies, validates the
// result, writes requirements.md and tasks.md to .conductor/plans/<slug>/ in
// the project, and returns one step per plan task, pinned to the task's agent.
// Steps whose dependencies are met run in parallel (StepExecutor).
//
// Tasks without a task_plans row use the default single-step plan.

export interface AgentPlannerDeps {
  store: Store;
  registry: Registry;
  getTask: (taskId: string) => Task | undefined;
  /** The base adapter input (workspace root, models, context) for a task. */
  baseInput: (task: Task, requiredCapability: string) => Record<string, unknown> | Promise<Record<string, unknown>>;
  agentName: (adapterId: string) => string;
  usage?: UsageRecorder;
  quota?: QuotaRecorder;
  emitter?: TaskEventEmitter;
  fallback?: Planner;
  /** Model and effort for a plan task on its agent (composer → Settings → Auto by difficulty). */
  resolveRun?: (task: Task, agentId: string, difficulty: Difficulty) => { models?: Record<string, string>; efforts?: Record<string, string>; runs: Record<string, ResolvedRun> };
  /** Load the agents' model lists before routing. */
  warm?: (agentIds: string[]) => Promise<void>;
}

interface PlanRow {
  task_id: string;
  planner_adapter_id: string;
  status: TaskPlanStatus;
  plan: string | null;
  docs_dir: string | null;
  error: string | null;
  planner_run?: string | null;
}

const PLAN_DIR = join('.conductor', 'plans');

/** A planner failure retryable on another agent (quota exhaustion or a bad model pick). */
class PlannerRetryableError extends Error {
  constructor(message: string, readonly kind: FailureKind) { super(message); this.name = 'PlannerRetryableError'; }
}

/** The available agents a plan may assign, most preferred first, as `id (Name)` lines. */
function agentList(registry: Registry, agentName: (id: string) => string): { ids: Set<string>; text: string } {
  const ids = new Set<string>();
  for (const adapter of registry.listAdapters()) {
    if (!adapter.available) continue;
    if (!adapter.capabilities.some((c) => c.id === `objective.fulfill.${adapter.id}`)) continue;
    ids.add(adapter.id);
  }
  const ordered = [...ids].sort(compareAgentPreference);
  return { ids: new Set(ordered), text: ordered.map((id) => `- "${id}" (${agentName(id)})`).join('\n') };
}

export function plannerPrompt(input: { objective: string; criteria: readonly string[]; agents: string; fallbackAgentId: string }): string {
  return [
    'You are the planner for Conductor, which runs several coding agents on one project at the same time.',
    'Read the project with the read, glob, grep and list tools; they need no approval. A shell command interrupts planning for the user to approve, so use one only when no read tool can answer (for example git log), and never change files.',
    'Then write a plan for the objective below. Reply with ONLY one JSON object in a ```json fenced block, shaped like this:',
    '{"title":"Short plan title","introduction":"What will be built and why, 2-5 sentences.",',
    ' "requirements":[{"id":"1","title":"...","userStory":"As a ..., I want ..., so that ...","acceptanceCriteria":["WHEN ... THEN ... SHALL ..."]}],',
    ' "groups":[{"id":"1","title":"...","tasks":[{"id":"1.1","title":"...","details":["concrete step","file or module to touch"],"requirements":["1.2"],"dependsOn":[],"agent":"opencode","difficulty":"simple"}]}]}',
    'Rules:',
    `- At most ${MAX_PLAN_TASKS} tasks in total. Each task is done by one agent in one session, so make each task a meaningful unit of work.`,
    '- Task ids are "<group>.<n>". "dependsOn" lists the ids of tasks that must finish first.',
    '- Tasks with no dependency path between them run at the same time on different agents, so they must not edit the same files. Add a dependency whenever a task needs another task\'s result.',
    '- "requirements" lists requirement ids ("1") or criterion ids ("1.2" = requirement 1, criterion 2) that the task implements.',
    `- "agent" is one of these available agents:\n${input.agents}\n  Pick the agent best suited to each task. Independent tasks in the same wave should use different agents so they run at the same time. If unsure, use "${input.fallbackAgentId}".`,
    '- "difficulty" is "simple" (a lookup, a small edit, a short answer), "moderate" or "complex" (substantial design or many files). Conductor gives simple tasks a cheaper model, so rate honestly.',
    '- If the objective is small, one group with one task is fine. Do not pad the plan.',
    '- Keep planning cheap: look at the file tree and only the few files you need to split the work. Do not read whole large files, run builds or tests, or load skills.',
    '',
    `Objective: ${input.objective}`,
    ...(input.criteria.length > 0 ? [`The user's acceptance checks for the whole result: ${input.criteria.join(' | ')}`] : []),
  ].join('\n');
}

export class AgentPlanner implements Planner {
  private readonly fallback: Planner;

  constructor(private readonly deps: AgentPlannerDeps) {
    this.fallback = deps.fallback ?? new PlaceholderPlanner();
  }

  /** Mark a task as plan mode, planned by `plannerAdapterId`. */
  request(taskId: string, plannerAdapterId: string): void {
    const now = new Date().toISOString();
    this.deps.store.db.prepare(`INSERT INTO task_plans (task_id, planner_adapter_id, status, created_at, updated_at)
      VALUES (?, ?, 'requested', ?, ?) ON CONFLICT(task_id) DO NOTHING`).run(taskId, plannerAdapterId, now, now);
  }

  async decompose(request: PlanRequest): Promise<PlanDecomposition> {
    const row = this.row(request.taskId);
    if (row === undefined) return this.fallback.decompose(request);
    const task = this.deps.getTask(request.taskId);
    if (task === undefined) throw new Error(`Task ${request.taskId} not found`);
    // A quick question or lookup doesn't need a plan: a planner session plus a
    // worker session would read the project twice. Run it directly instead.
    if (assessDifficulty(task.objective) === 'simple') {
      this.deps.store.db.prepare('DELETE FROM task_plans WHERE task_id = ?').run(task.id);
      this.log(task.id, `Quick request: ${this.deps.agentName(row.planner_adapter_id)} answers it directly, without a plan, to save tokens.`);
      return { steps: [{ id: 'step-1', description: `Fulfill objective: ${task.objective}`, requiredCapability: `objective.fulfill.${row.planner_adapter_id}` }] };
    }
    this.setStatus(task.id, 'planning');
    // Planners to try: the chosen one first, then the other available planner
    // agents. If the chosen planner's usage/quota is exhausted, fall back to
    // the next provider rather than blocking the task.
    const available = agentList(this.deps.registry, this.deps.agentName).ids;
    const order = [row.planner_adapter_id, ...[...available].filter((id) => id !== row.planner_adapter_id)];
    let lastError = `No planner agent is available. Check Connections, then retry.`;
    try {
      for (let i = 0; i < order.length; i += 1) {
        const plannerId = order[i]!;
        const more = order.length - 1 - i;
        try {
          const plan = await this.runPlanner(task, plannerId);
          if (plannerId !== row.planner_adapter_id) {
            // Pin the plan to the planner that actually produced it.
            this.deps.store.db.prepare('UPDATE task_plans SET planner_adapter_id = ? WHERE task_id = ?').run(plannerId, task.id);
          }
          const docsDir = this.writeDocs(task, plan, plannerId);
          this.deps.store.db.prepare(`UPDATE task_plans SET status = 'ready', plan = ?, docs_dir = ?, error = NULL, updated_at = ? WHERE task_id = ?`)
            .run(JSON.stringify(plan), docsDir ?? null, new Date().toISOString(), task.id);
          const waves = computeWaves(plan);
          this.log(task.id, `Plan ready: ${planTasks(plan).length} task${planTasks(plan).length === 1 ? '' : 's'} in ${waves.length} wave${waves.length === 1 ? '' : 's'}${docsDir ? ` · saved to ${docsDir}` : ''}`);
          return { steps: planTasks(plan).map((t) => this.stepFor(task, plan, t.id, docsDir)) };
        } catch (error) {
          const current = this.deps.getTask(task.id);
          if (current === undefined || ['CANCELLED', 'FAILED', 'COMPLETED'].includes(current.state)) throw error;
          lastError = error instanceof Error ? error.message : String(error);
          // Quota exhaustion or a model the CLI cannot run is worth another
          // provider; both are retryable on a different agent.
          if (!(error instanceof PlannerRetryableError) || more === 0) throw error;
          const next = this.deps.agentName(order[i + 1]!);
          this.log(task.id, error.kind === 'quota_exhausted'
            ? `${this.deps.agentName(plannerId)} is out of capacity, so ${next} will write the plan instead.`
            : `${this.deps.agentName(plannerId)} couldn't run the selected model, so ${next} will write the plan instead.`,
            { agentFallback: true });
        }
      }
      throw new Error(lastError);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.store.db.prepare(`UPDATE task_plans SET status = 'failed', error = ?, updated_at = ? WHERE task_id = ?`)
        .run(message, new Date().toISOString(), task.id);
      throw error;
    }
  }

  /** Rewrite tasks.md so finished tasks are ticked. */
  refresh(taskId: string): void {
    const row = this.row(taskId);
    if (row?.status !== 'ready' || row.plan === null || row.docs_dir === null) return;
    const task = this.deps.getTask(taskId);
    if (task === undefined) return;
    const plan = JSON.parse(row.plan) as AgentPlan;
    const statuses = this.stepStatuses(taskId);
    try {
      writeFileSync(join(row.docs_dir, 'tasks.md'), renderTasks(plan, {
        objective: task.objective, plannerName: this.deps.agentName(row.planner_adapter_id), agentName: this.deps.agentName,
        status: (id) => statuses.get(id)?.status,
      }));
    } catch { /* the folder may have been moved or deleted; the plan in the app is unaffected */ }
  }

  /** The plan for the task details view, or null for a non-plan task. */
  view(taskId: string): TaskPlanView | null {
    const row = this.row(taskId);
    if (row === undefined) return null;
    const plan = row.plan !== null ? JSON.parse(row.plan) as AgentPlan : undefined;
    const steps = Object.fromEntries([...this.stepStatuses(taskId)].map(([planId, s]) => [planId, s.stepId]));
    return {
      plannerAdapterId: row.planner_adapter_id, status: row.status,
      ...(row.error !== null ? { error: row.error } : {}),
      ...(row.docs_dir !== null ? { docsDir: row.docs_dir } : {}),
      ...(row.planner_run ? { plannerRun: JSON.parse(row.planner_run) as NonNullable<TaskPlanView['plannerRun']> } : {}),
      ...(plan !== undefined ? { plan, waves: computeWaves(plan), steps } : {}),
    };
  }

  private row(taskId: string): PlanRow | undefined {
    return this.deps.store.db.prepare('SELECT * FROM task_plans WHERE task_id = ?').get(taskId) as PlanRow | undefined;
  }

  private setStatus(taskId: string, status: TaskPlanStatus): void {
    this.deps.store.db.prepare('UPDATE task_plans SET status = ?, updated_at = ? WHERE task_id = ?').run(status, new Date().toISOString(), taskId);
  }

  /** Plan task id → its step's id and status (step descriptions start with the plan task id). */
  private stepStatuses(taskId: string): Map<string, { stepId: string; status: PlanTaskStatus }> {
    const rows = this.deps.store.db.prepare('SELECT id, description, status FROM task_steps WHERE task_id = ?').all(taskId) as { id: string; description: string; status: PlanTaskStatus }[];
    return new Map(rows.map((r) => [r.description.split(' ')[0]!, { stepId: r.id, status: r.status }]));
  }

  private log(taskId: string, message: string, extra: Record<string, unknown> = {}): void {
    this.deps.store.db.prepare("INSERT INTO task_events (id, task_id, kind, payload, created_at) VALUES (?, ?, 'log', ?, ?)")
      .run(randomUUID(), taskId, JSON.stringify({ message, phase: 'planning', ...extra }), new Date().toISOString());
    const task = this.deps.getTask(taskId);
    if (task !== undefined) this.deps.emitter?.emit('task.updated', task);
  }

  private async runPlanner(task: Task, plannerId: string): Promise<AgentPlan> {
    const { registry, store } = this.deps;
    const agents = agentList(registry, this.deps.agentName);
    await this.deps.warm?.([...agents.ids]).catch(() => undefined);
    if (!agents.ids.has(plannerId)) throw new Error(`The planner agent (${this.deps.agentName(plannerId)}) is not available. Check Connections, then retry.`);
    // A plan task the planner did not name (or named an unavailable agent)
    // goes to the most preferred available agent, not necessarily the planner.
    // This keeps an Antigravity planner from assigning every task to itself.
    const fallbackAgentId = preferredAgent(agents.ids) ?? plannerId;
    const adapter = registry.resolve(plannerId);
    const base = await this.deps.baseInput(task, `objective.fulfill.${plannerId}`);
    const runs = base['runs'] as Record<string, unknown> | undefined;
    const plannerRun = runs?.[plannerId];
    if (plannerRun !== undefined) store.db.prepare('UPDATE task_plans SET planner_run = ? WHERE task_id = ?').run(JSON.stringify(plannerRun), task.id);
    const input = {
      ...base,
      objective: plannerPrompt({ objective: task.objective, criteria: task.acceptanceCriteria, agents: agents.text, fallbackAgentId }),
      description: 'Write the plan',
      acceptanceCriteria: ['Reply with one JSON plan object as described.'],
      guidance: 'Planning only: keep exploration to the minimum needed to split the work.',
      // The planner reads, and may ask before running a command (e.g. git
      // log); file changes are still declined. Approval_requests.step_id is a
      // free correlation id, and the plan has no step row yet.
      mode: 'read_only',
      approveCommands: true,
      stepId: 'plan',
      resume: undefined,
      taskId: task.id,
    };
    this.log(task.id, `Planning with ${this.deps.agentName(plannerId)}…`);
    const handle = await adapter.start(input);
    const now = new Date().toISOString();
    store.db.prepare(`INSERT INTO agent_sessions (id, task_id, adapter_id, external_ref, status, resumable, created_at, step_id)
      VALUES (?, ?, ?, ?, 'live', 0, ?, NULL)`).run(handle.sessionId, task.id, plannerId, handle.externalRef ?? null, now);
    const stdout: string[] = [];
    const stderr: string[] = [];
    let ok = false;
    try {
      for await (const ev of adapter.stream(handle)) {
        this.observe(task.id, handle.sessionId, plannerId, ev, stdout, stderr);
      }
      const result = await adapter.await(handle);
      ok = result.status === 'succeeded';
      const current = this.deps.getTask(task.id);
      if (current === undefined || ['CANCELLED', 'FAILED', 'COMPLETED'].includes(current.state)) throw new Error('Planning stopped because the task ended.');
      if (!ok) {
        const detail = result.error ?? stderr.filter((l) => l.trim() !== '').slice(-3).join('\n');
        const message = `The planner (${this.deps.agentName(plannerId)}) did not finish${detail ? `: ${detail}` : '.'}`;
        // Quota exhaustion and an unavailable/conflicting model are retryable
        // on a different provider; signal that to the fallback loop rather
        // than blocking the task outright.
        const kind = classifyFailure(result, tailLines([...stdout, ...stderr]));
        throw retryableOnAnotherAgent(kind) ? new PlannerRetryableError(message, kind) : new Error(message);
      }
    } finally {
      store.db.prepare('UPDATE agent_sessions SET status = ? WHERE id = ?').run(ok ? 'exited' : 'orphaned', handle.sessionId);
    }
    const raw = stdout.join('\n');
    const reply = isCodexProtocol(plannerId) ? responseText(raw) : raw;
    return validatePlan(extractPlanJson(reply), agents.ids, fallbackAgentId, (entry) => {
      // The planner named an agent that is no longer available. Say so in the
      // thread instead of silently running the task somewhere else.
      this.log(task.id, `${this.deps.agentName(entry.requestedAgent)} isn't available, so ${this.deps.agentName(fallbackAgentId)} will take task ${entry.planTaskId} ("${entry.title}") instead.`, { agentFallback: true });
    });
  }

  /** Collect the reply, record usage, and surface the planner's activity in the thread. */
  private observe(taskId: string, sessionId: string, plannerId: string, ev: AdapterStreamEvent, stdout: string[], stderr: string[]): void {
    const usage = usageFromEvent(ev);
    if (usage !== undefined) {
      try { this.deps.usage?.record({ sessionId, taskId, adapterId: plannerId, sample: usage }); } catch { /* informational */ }
    }
    const quota = quotaFromEvent(ev);
    if (quota !== undefined) {
      try { this.deps.quota?.record({ adapterId: plannerId, sample: quota }); } catch { /* informational */ }
    }
    if (ev.kind === 'stderr' && typeof ev.data === 'string') { stderr.push(ev.data); return; }
    if (ev.kind !== 'stdout' || typeof ev.data !== 'string') return;
    stdout.push(ev.data);
    // Codex JSONL: show the commands the planner ran while reading the project.
    if (!ev.data.startsWith('{')) return;
    try {
      const line = JSON.parse(ev.data) as { type?: string; item?: { type?: string; command?: string } };
      if (line.type === 'item.completed' && line.item?.type === 'command_execution' && typeof line.item.command === 'string') {
        this.log(taskId, `Planner ran ${line.item.command.replace(/^(?:\/bin\/)?(?:bash|zsh|sh) -lc ['"]?|['"]$/g, '').slice(0, 200)}`);
      }
    } catch { /* not JSON */ }
  }

  private writeDocs(task: Task, plan: AgentPlan, plannerId: string): string | undefined {
    const root = this.deps.store.db.prepare('SELECT root_path FROM workspaces WHERE id = ?').get(task.workspaceId) as { root_path: string } | undefined;
    if (root === undefined) return undefined;
    const base = planSlug(plan.title, new Date());
    let dir = join(root.root_path, PLAN_DIR, base);
    for (let n = 2; existsSync(dir) && n < 100; n += 1) dir = join(root.root_path, PLAN_DIR, `${base}-${n}`);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'requirements.md'), renderRequirements(plan, task.objective));
      writeFileSync(join(dir, 'tasks.md'), renderTasks(plan, { objective: task.objective, plannerName: this.deps.agentName(plannerId), agentName: this.deps.agentName }));
      return dir;
    } catch (error) {
      this.log(task.id, `Could not save the plan documents: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  private stepFor(task: Task, plan: AgentPlan, planTaskId: string, docsDir: string | undefined): PlannedStep {
    const planTask = planTasks(plan).find((t) => t.id === planTaskId)!;
    const criteria = referencedCriteria(plan, planTask);
    const objective = [
      `Overall objective: ${task.objective}`,
      '',
      `You are one of several agents carrying out the plan "${plan.title}" at the same time. Do only this task:`,
      `${planTask.id} ${planTask.title}`,
      ...planTask.details.map((d) => `- ${d}`),
      ...(criteria.length > 0 ? ['', 'Requirements this task implements:', ...criteria.map((c) => `- ${c}`)] : []),
      '',
      'Other agents work on the other tasks in parallel: do not edit files outside this task, and do not undo changes you did not make.',
      ...(docsDir ? [`The full plan is in ${join(docsDir, 'requirements.md')} and ${join(docsDir, 'tasks.md')}.`] : []),
      'When you are done, reply with a short summary of what you changed.',
    ].join('\n');
    return {
      id: planTask.id,
      description: `${planTask.id} ${planTask.title}`,
      requiredCapability: `objective.fulfill.${planTask.agent}`,
      dependsOn: planTask.dependsOn,
      input: {
        objective, acceptanceCriteria: criteria.length > 0 ? criteria : [planTask.title], resume: undefined,
        difficulty: planTask.difficulty,
        ...(economyGuidance(planTask.difficulty) ? { guidance: economyGuidance(planTask.difficulty) } : {}),
        ...(this.deps.resolveRun !== undefined ? this.deps.resolveRun(task, planTask.agent, planTask.difficulty) : {}),
      },
    };
  }
}

export type { PlanTaskStatus };
