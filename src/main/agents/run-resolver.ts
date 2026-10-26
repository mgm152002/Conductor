import type { Difficulty, ResolvedRun, RunChoice, RunOptions } from '@shared/agent-models';
import { AGENT_PREFERENCE_ORDER } from '@shared/agent-preference';
import { defaultModelKey, fallbackModelKey, isValidModelId } from '@shared/model-defaults';
import type { Task } from '@shared/domain';
import type { Store } from '../db/types';
import type { SettingsService } from '../domain/settings-service';
import { NO_VALUE } from '../domain/settings-service';
import type { ModelCatalogService } from './model-catalog';
import { assessDifficulty, chooseRun } from './model-routing';

// Decides the model and reasoning effort each agent runs with:
//   1. the composer's choice for this message (task.run_options),
//   2. Settings → Agent models,
//   3. Auto: by how demanding the work is (assessDifficulty, or the planner's
//      rating of a plan task), using the agent's own model list.

const MODEL = /^[\w./:@-]{1,100}$/;
const EFFORT = /^[a-z]{2,12}$/;

/** The CLIs that can run a task, in the shared preference order. */
export const RUNNABLE_AGENTS = AGENT_PREFERENCE_ORDER;

export interface ResolvedInput {
  models?: Record<string, string>;
  efforts?: Record<string, string>;
  /** What each agent would run with, keyed by agent id. */
  runs: Record<string, ResolvedRun>;
}

export function parseRunOptions(raw: unknown): RunOptions {
  const clean = (v: unknown): RunChoice | undefined => {
    if (v === null || typeof v !== 'object') return undefined;
    const c = v as Record<string, unknown>;
    const out: RunChoice = {};
    if (typeof c['model'] === 'string' && MODEL.test(c['model'])) out.model = c['model'];
    if (typeof c['effort'] === 'string' && EFFORT.test(c['effort'])) out.effort = c['effort'];
    return Object.keys(out).length > 0 ? out : undefined;
  };
  if (raw === null || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const main = clean(r['main']);
  const mainAgentId = typeof r['mainAgentId'] === 'string' && /^[\w:.-]{1,200}$/.test(r['mainAgentId'])
    ? r['mainAgentId'] : undefined;
  const agents: Record<string, RunChoice> = {};
  if (r['agents'] !== null && typeof r['agents'] === 'object') {
    for (const [id, choice] of Object.entries(r['agents'] as Record<string, unknown>)) {
      const c = clean(choice);
      if (c !== undefined && /^[\w:.-]{1,200}$/.test(id)) agents[id] = c;
    }
  }
  return {
    ...(main ? { main } : {}),
    ...(mainAgentId !== undefined ? { mainAgentId } : {}),
    ...(Object.keys(agents).length > 0 ? { agents } : {}),
  };
}

export class RunResolver {
  constructor(
    private readonly store: Store,
    private readonly settings: SettingsService | undefined,
    private readonly catalogs: ModelCatalogService | undefined,
  ) {}

  /** Save the composer's choices for a message. */
  save(taskId: string, options: RunOptions, mainAgentId?: string): void {
    const clean = parseRunOptions({
      ...options,
      ...(mainAgentId !== undefined ? { mainAgentId } : {}),
    });
    if (Object.keys(clean).length === 0) return;
    this.store.db.prepare('UPDATE tasks SET run_options = ? WHERE id = ?').run(JSON.stringify(clean), taskId);
  }

  options(taskId: string): RunOptions {
    const row = this.store.db.prepare('SELECT run_options FROM tasks WHERE id = ?').get(taskId) as { run_options: string | null } | undefined;
    if (row?.run_options == null) return {};
    try { return parseRunOptions(JSON.parse(row.run_options)); } catch { return {}; }
  }

  private setting(agentId: string): RunChoice | undefined {
    if (this.settings === undefined) return undefined;
    const read = (key: string): string | undefined => {
      const value = this.settings!.resolve(key);
      return value !== NO_VALUE && typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
    };
    const model = read(defaultModelKey(agentId));
    const effort = read(`agents.${agentId}.effort`);
    const out: RunChoice = {};
    if (model !== undefined && (isValidModelId(model) || MODEL.test(model))) out.model = model;
    if (effort !== undefined && EFFORT.test(effort)) out.effort = effort;
    return Object.keys(out).length > 0 ? out : undefined;
  }

  /** The fallback model configured for an agent in Settings. */
  fallbackModel(agentId: string): string | undefined {
    if (this.settings === undefined) return undefined;
    const value = this.settings.resolve(fallbackModelKey(agentId));
    if (value === NO_VALUE || typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    if (!(isValidModelId(trimmed) || MODEL.test(trimmed))) return undefined;
    return trimmed;
  }

  /**
   * Models and efforts for every agent, for one run.
   * `role: 'main'` is the message's own agent (or the planner); 'subagent' is
   * an agent running a plan task.
   */
  resolve(task: Task, input: { role: 'main' | 'subagent'; difficulty?: Difficulty; agents?: readonly string[] }): ResolvedInput {
    const options = this.options(task.id);
    const difficulty = input.difficulty ?? assessDifficulty(task.objective);
    const models: Record<string, string> = {};
    const efforts: Record<string, string> = {};
    const runs: Record<string, ResolvedRun> = {};
    for (const agentId of input.agents ?? RUNNABLE_AGENTS) {
      // Old saved tasks have no mainAgentId, so retain their historical
      // behavior. New tasks bind the choice to the selected CLI; a fallback
      // provider then uses its own Settings/Auto model instead of receiving a
      // foreign model id.
      const explicit = input.role === 'main'
        ? (options.mainAgentId === undefined || options.mainAgentId === agentId ? options.main : undefined)
        : options.agents?.[agentId];
      const run = chooseRun({ catalog: this.catalogs?.cached(agentId), difficulty, explicit, settings: this.setting(agentId) });
      runs[agentId] = run;
      if (run.model !== undefined) models[agentId] = run.model;
      if (run.effort !== undefined) efforts[agentId] = run.effort;
    }
    return { ...(Object.keys(models).length > 0 ? { models } : {}), ...(Object.keys(efforts).length > 0 ? { efforts } : {}), runs };
  }
}
