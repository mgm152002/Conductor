import type { AdapterStreamEvent } from '@shared/adapter';
import type { AdapterRecord } from '@shared/domain';
import type {
  UsageClient, UsageLimitStatus, UsageLimitWindow, UsageLimitWindowKind, UsageRange, UsageRow, UsageSummary,
} from '@shared/usage';
import type { Store } from '../db/types';
import { estimateCostUsd, type PriceLookup } from './pricing';
import { isQuotaWindowCurrent } from './quota';

// Token usage per agent session. Adapters report usage as a `log` stream
// event whose data is `{ usage: UsageSample }` carrying the session's running
// totals; `codex exec --json` reports it on its `turn.completed` line. The
// recorder keeps one row per session and overwrites it with the latest totals.
//
// Cost is never taken from a harness report (`total_cost_usd`, ACP `cost`,
// and friends are dropped here): summaries price the recorded tokens from
// the public models.dev catalogue instead (see `./pricing`).

export interface UsageSample {
  model?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Json : null);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

const FIELDS = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens', 'totalTokens'] as const;

/** Keep only well-formed, non-negative numbers (and a short model name). */
export function cleanSample(value: unknown): UsageSample | undefined {
  const raw = obj(value);
  if (raw === null) return undefined;
  const sample: UsageSample = {};
  for (const field of FIELDS) {
    const n = num(raw[field]);
    if (n !== undefined) sample[field] = n;
  }
  if (typeof raw['model'] === 'string' && /^[\w./:@-]{1,100}$/.test(raw['model'])) sample.model = raw['model'];
  return Object.keys(sample).length > 0 ? sample : undefined;
}

/** The usage an adapter stream event reports, if any. */
export function usageFromEvent(ev: AdapterStreamEvent): UsageSample | undefined {
  if (ev.kind === 'log') return cleanSample(obj(ev.data)?.['usage']);
  if (ev.kind !== 'stdout' || typeof ev.data !== 'string' || !ev.data.includes('"turn.completed"')) return undefined;
  try {
    const line = obj(JSON.parse(ev.data));
    if (line?.['type'] !== 'turn.completed') return undefined;
    const usage = obj(line['usage']);
    if (usage === null) return undefined;
    return cleanSample({
      inputTokens: usage['input_tokens'], cachedInputTokens: usage['cached_input_tokens'],
      outputTokens: usage['output_tokens'], reasoningTokens: usage['reasoning_output_tokens'], totalTokens: usage['total_tokens'],
    });
  } catch {
    return undefined;
  }
}

export class UsageRecorder {
  constructor(private readonly store: Store) {}

  record(input: { sessionId: string; taskId: string; stepId?: string | undefined; adapterId: string; sample: UsageSample }): void {
    const { sample } = input;
    const now = new Date().toISOString();
    const existing = this.store.db.prepare('SELECT * FROM agent_usage WHERE session_id = ?').get(input.sessionId) as Record<string, unknown> | undefined;
    const pick = (field: typeof FIELDS[number], column: string): number | null => {
      const value = sample[field];
      if (value !== undefined) return value;
      const prior = existing?.[column];
      return typeof prior === 'number' ? prior : null;
    };
    const inputTokens = pick('inputTokens', 'input_tokens') ?? 0;
    const outputTokens = pick('outputTokens', 'output_tokens') ?? 0;
    const total = sample.totalTokens ?? (sample.inputTokens !== undefined || sample.outputTokens !== undefined ? inputTokens + outputTokens : pick('totalTokens', 'total_tokens') ?? 0);
    const row = {
      model: sample.model ?? (existing?.['model'] as string | null | undefined) ?? null,
      input: inputTokens, cached: pick('cachedInputTokens', 'cached_input_tokens') ?? 0, output: outputTokens,
      reasoning: pick('reasoningTokens', 'reasoning_tokens') ?? 0, total,
    };
    if (existing !== undefined) {
      // cost_usd is cleared, not carried: legacy rows hold harness-reported
      // cost, which summaries no longer use (they price tokens publicly).
      this.store.db.prepare(`UPDATE agent_usage SET model=?, input_tokens=?, cached_input_tokens=?, output_tokens=?, reasoning_tokens=?,
        total_tokens=?, cost_usd=NULL, updated_at=? WHERE session_id=?`)
        .run(row.model, row.input, row.cached, row.output, row.reasoning, row.total, now, input.sessionId);
      return;
    }
    const task = this.store.db.prepare('SELECT workspace_id FROM tasks WHERE id = ?').get(input.taskId) as { workspace_id: string } | undefined;
    if (task === undefined) return;
    this.store.db.prepare(`INSERT INTO agent_usage (session_id, task_id, step_id, workspace_id, adapter_id, model, input_tokens,
      cached_input_tokens, output_tokens, reasoning_tokens, total_tokens, cost_usd, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.sessionId, input.taskId, input.stepId ?? null, task.workspace_id, input.adapterId, row.model,
        row.input, row.cached, row.output, row.reasoning, row.total, null, now, now);
  }
}

const RANGE_DAYS: Record<UsageRange, number | null> = { '24h': 1, '7d': 7, '30d': 30, '90d': 90, all: null };

interface Aggregate {
  key: string; sessions: number; input: number; cached: number; output: number; reasoning: number; total: number; cost?: number;
}

const emptyAggregate = (key: string): Aggregate => ({
  key, sessions: 0, input: 0, cached: 0, output: 0, reasoning: 0, total: 0,
});

function toRow(a: Aggregate, label: string): UsageRow {
  return {
    key: a.key, label, sessions: a.sessions, inputTokens: a.input, cachedInputTokens: a.cached, outputTokens: a.output,
    reasoningTokens: a.reasoning, totalTokens: a.total, ...(a.cost !== undefined ? { costUsd: a.cost } : {}),
  };
}

/** One (adapter, project, model) slice of recorded usage, priced in JS. */
interface UsageGroup {
  adapter: string;
  workspace: string;
  model: string;
  sessions: number;
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  total: number;
}

function addTo(map: Map<string, Aggregate>, group: UsageGroup, key: string, pricing: UsageSummaryOptions['pricing']): void {
  const aggregate = map.get(key) ?? emptyAggregate(key);
  aggregate.sessions += group.sessions;
  aggregate.input += group.input;
  aggregate.cached += group.cached;
  aggregate.output += group.output;
  aggregate.reasoning += group.reasoning;
  aggregate.total += group.total;
  const price = pricing?.(group.model === '' ? undefined : group.model, group.adapter);
  if (price !== undefined) {
    aggregate.cost = (aggregate.cost ?? 0) + estimateCostUsd(price, {
      inputTokens: group.input, cachedInputTokens: group.cached, outputTokens: group.output,
    });
  }
  map.set(key, aggregate);
}

/** A stored quota window as returned by `agent_usage_limits`. */
interface LimitRow {
  adapter_id: string;
  window_kind: string;
  remaining_percent: number | null;
  used_percent: number | null;
  resets_at: string | null;
  reported_at: string;
  source: string | null;
  window_minutes: number | null;
  label: string | null;
}

function limitKind(value: string): UsageLimitWindowKind {
  return value === 'weekly' ? 'weekly' : value === 'daily' ? 'daily' : 'session';
}

function toLimitWindow(row: LimitRow): UsageLimitWindow {
  return {
    kind: limitKind(row.window_kind),
    ...(row.remaining_percent !== null ? { remainingPercent: row.remaining_percent } : {}),
    ...(row.used_percent !== null ? { usedPercent: row.used_percent } : {}),
    ...(row.resets_at !== null ? { resetsAt: row.resets_at } : {}),
    ...(row.reported_at ? { reportedAt: row.reported_at } : {}),
    ...(row.source !== null ? { source: row.source } : {}),
    ...(row.window_minutes !== null ? { windowMinutes: row.window_minutes } : {}),
    ...(row.label !== null ? { label: row.label } : {}),
  };
}

export interface UsageSummaryOptions {
  /**
   * The currently registered adapters (from `registry.listAdapters()`). Every
   * attached local CLI agent appears under `clients`, even with no usage in the
   * selected range or no reported limits.
   */
  adapters?: readonly AdapterRecord[];
  /**
   * Public per-model prices (models.dev) used to estimate cost from recorded
   * tokens. Without a price for a model, that usage contributes tokens but no
   * cost — harness-reported cost is never used as a fallback.
   */
  pricing?: PriceLookup;
  /** Why a CLI's latest quota probe reported nothing, keyed by adapter id. */
  limitStatuses?: Readonly<Record<string, UsageLimitStatus>>;
}

const SUMS = `COUNT(*) AS sessions, SUM(input_tokens) AS input, SUM(cached_input_tokens) AS cached, SUM(output_tokens) AS output,
  SUM(reasoning_tokens) AS reasoning, SUM(total_tokens) AS total`;

/** Usage totals for a time range, by agent/project/model and per attached CLI. */
export function usageSummary(
  store: Store,
  input: { range: UsageRange; workspaceId?: string | undefined },
  agentName: (id: string) => string,
  options: UsageSummaryOptions = {},
): UsageSummary {
  const days = RANGE_DAYS[input.range];
  const where: string[] = [];
  const params: unknown[] = [];
  if (days !== null) { where.push('u.created_at >= ?'); params.push(new Date(Date.now() - days * 86_400_000).toISOString()); }
  if (input.workspaceId !== undefined) { where.push('u.workspace_id = ?'); params.push(input.workspaceId); }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  // Cost must be priced per model, so aggregate at (adapter, project, model)
  // granularity and roll the groups up in JS; the stored `cost_usd` column
  // (legacy harness reports) is deliberately never read.
  const groups = store.db.prepare(`SELECT adapter_id AS adapter, workspace_id AS workspace,
      COALESCE(model, '') AS model, ${SUMS} FROM agent_usage u ${clause}
    GROUP BY adapter_id, workspace_id, model`).all(...params) as UsageGroup[];
  const totalsMap = new Map<string, Aggregate>();
  const byAgentMap = new Map<string, Aggregate>();
  const byProjectMap = new Map<string, Aggregate>();
  const byModelMap = new Map<string, Aggregate>();
  for (const group of groups) {
    addTo(totalsMap, group, 'all', options.pricing);
    addTo(byAgentMap, group, group.adapter, options.pricing);
    addTo(byProjectMap, group, group.workspace, options.pricing);
    addTo(byModelMap, group, `${group.adapter} · ${group.model === '' ? 'default model' : group.model}`, options.pricing);
  }
  const totals = totalsMap.get('all') ?? emptyAggregate('all');
  const byAgent = [...byAgentMap.values()].sort((a, b) => b.total - a.total);
  const workspaceNames = new Map(
    (store.db.prepare('SELECT id, name FROM workspaces').all() as Array<{ id: string; name: string }>)
      .map((row) => [row.id, row.name] as const),
  );
  const byProject = [...byProjectMap.values()].sort((a, b) => b.total - a.total);
  const byModel = [...byModelMap.values()].sort((a, b) => b.total - a.total).slice(0, 20);

  const limitsByAdapter = new Map<string, UsageLimitWindow[]>();
  const limitRows = store.db.prepare(`SELECT adapter_id, window_kind, remaining_percent, used_percent, resets_at,
    reported_at, source, window_minutes, label FROM agent_usage_limits
    ORDER BY adapter_id, CASE window_kind WHEN 'session' THEN 0 WHEN 'daily' THEN 1 ELSE 2 END, label`).all() as LimitRow[];
  const now = new Date();
  for (const row of limitRows) {
    const window = toLimitWindow(row);
    // An expired window is stale, not a current limit: leave it unreported.
    if (!isQuotaWindowCurrent(window, now)) continue;
    const list = limitsByAdapter.get(row.adapter_id) ?? [];
    list.push(window);
    limitsByAdapter.set(row.adapter_id, list);
  }

  const used = new Map(byAgent.map((a) => [a.key, a]));
  // Most recent session per CLI at any time (ignores the selected range), so
  // a CLI with nothing in range can still say when it was last used.
  const lastUsed = new Map(
    (store.db.prepare(`SELECT adapter_id AS adapter, MAX(created_at) AS at FROM agent_usage u
      ${input.workspaceId !== undefined ? 'WHERE u.workspace_id = ?' : ''} GROUP BY adapter_id`)
      .all(...(input.workspaceId !== undefined ? [input.workspaceId] : [])) as Array<{ adapter: string; at: string | null }>)
      .map((row) => [row.adapter, row.at] as const),
  );
  const extras = (id: string): Pick<UsageClient, 'limits' | 'lastUsedAt' | 'limitStatus'> => {
    const limits = limitsByAdapter.get(id) ?? [];
    const at = lastUsed.get(id);
    const status = options.limitStatuses?.[id];
    return {
      limits,
      ...(typeof at === 'string' ? { lastUsedAt: at } : {}),
      // A status explains missing windows; it is moot once windows exist.
      ...(limits.length === 0 && status !== undefined ? { limitStatus: status } : {}),
    };
  };
  const clients = new Map<string, UsageClient>();
  for (const adapter of options.adapters ?? []) {
    if (adapter.class !== 'local_cli_agent') continue;
    const aggregate = used.get(adapter.id) ?? emptyAggregate(adapter.id);
    clients.set(adapter.id, { ...toRow(aggregate, adapter.name || agentName(adapter.id)), ...extras(adapter.id) });
  }
  // Keep historical usage from CLIs that are no longer registered visible.
  for (const aggregate of byAgent) {
    if (clients.has(aggregate.key)) continue;
    clients.set(aggregate.key, { ...toRow(aggregate, agentName(aggregate.key)), ...extras(aggregate.key) });
  }
  const clientList = [...clients.values()].sort((a, b) => b.totalTokens - a.totalTokens || a.label.localeCompare(b.label));

  return {
    range: input.range,
    totals: toRow(totals, 'All agents'),
    byAgent: byAgent.map((a) => toRow(a, agentName(a.key))),
    byProject: byProject.map((a) => toRow(a, workspaceNames.get(a.key) ?? 'Deleted project')),
    byModel: byModel.map((a) => {
      const [agent, model] = a.key.split(' · ');
      return toRow(a, `${agentName(agent ?? '')} · ${model ?? ''}`);
    }),
    clients: clientList,
  };
}

/** Token totals for one task, overall and per step (the planner has no step). */
export function taskUsage(
  store: Store,
  taskId: string,
  pricing?: PriceLookup,
): { total: UsageRow | null; byStep: Record<string, UsageRow> } {
  const groups = store.db.prepare(`SELECT COALESCE(step_id, 'planner') AS step, adapter_id AS adapter,
      '' AS workspace, COALESCE(model, '') AS model, ${SUMS} FROM agent_usage u WHERE task_id = ? GROUP BY step_id, adapter_id, model`)
    .all(taskId) as Array<UsageGroup & { step: string }>;
  if (groups.length === 0) return { total: null, byStep: {} };
  const byStepMap = new Map<string, Aggregate>();
  const totalMap = new Map<string, Aggregate>();
  for (const group of groups) {
    addTo(byStepMap, group, group.step, pricing);
    addTo(totalMap, group, 'task', pricing);
  }
  const byStep: Record<string, UsageRow> = {};
  for (const [step, aggregate] of byStepMap) byStep[step] = toRow(aggregate, step);
  return { total: toRow(totalMap.get('task') ?? emptyAggregate('task'), 'This message'), byStep };
}
