import type { AdapterStreamEvent } from '@shared/adapter';
import type { UsageRange, UsageRow, UsageSummary } from '@shared/usage';
import type { Store } from '../db/types';

// Token usage per agent session. Adapters report usage as a `log` stream
// event whose data is `{ usage: UsageSample }` carrying the session's running
// totals; `codex exec --json` reports it on its `turn.completed` line. The
// recorder keeps one row per session and overwrites it with the latest totals.

export interface UsageSample {
  model?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Json : null);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

const FIELDS = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens', 'totalTokens', 'costUsd'] as const;

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
      reasoning: pick('reasoningTokens', 'reasoning_tokens') ?? 0, total, cost: pick('costUsd', 'cost_usd'),
    };
    if (existing !== undefined) {
      this.store.db.prepare(`UPDATE agent_usage SET model=?, input_tokens=?, cached_input_tokens=?, output_tokens=?, reasoning_tokens=?,
        total_tokens=?, cost_usd=?, updated_at=? WHERE session_id=?`)
        .run(row.model, row.input, row.cached, row.output, row.reasoning, row.total, row.cost, now, input.sessionId);
      return;
    }
    const task = this.store.db.prepare('SELECT workspace_id FROM tasks WHERE id = ?').get(input.taskId) as { workspace_id: string } | undefined;
    if (task === undefined) return;
    this.store.db.prepare(`INSERT INTO agent_usage (session_id, task_id, step_id, workspace_id, adapter_id, model, input_tokens,
      cached_input_tokens, output_tokens, reasoning_tokens, total_tokens, cost_usd, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.sessionId, input.taskId, input.stepId ?? null, task.workspace_id, input.adapterId, row.model,
        row.input, row.cached, row.output, row.reasoning, row.total, row.cost, now, now);
  }
}

const RANGE_DAYS: Record<UsageRange, number | null> = { '7d': 7, '30d': 30, all: null };

interface Aggregate {
  key: string; sessions: number; input: number; cached: number; output: number; reasoning: number; total: number; cost: number | null;
}

function toRow(a: Aggregate, label: string): UsageRow {
  return {
    key: a.key, label, sessions: a.sessions, inputTokens: a.input, cachedInputTokens: a.cached, outputTokens: a.output,
    reasoningTokens: a.reasoning, totalTokens: a.total, ...(a.cost !== null ? { costUsd: a.cost } : {}),
  };
}

const SUMS = `COUNT(*) AS sessions, SUM(input_tokens) AS input, SUM(cached_input_tokens) AS cached, SUM(output_tokens) AS output,
  SUM(reasoning_tokens) AS reasoning, SUM(total_tokens) AS total, SUM(cost_usd) AS cost`;

/** Usage totals for a time range, by agent and by project. */
export function usageSummary(store: Store, input: { range: UsageRange; workspaceId?: string | undefined }, agentName: (id: string) => string): UsageSummary {
  const days = RANGE_DAYS[input.range];
  const where: string[] = [];
  const params: unknown[] = [];
  if (days !== null) { where.push('u.created_at >= ?'); params.push(new Date(Date.now() - days * 86_400_000).toISOString()); }
  if (input.workspaceId !== undefined) { where.push('u.workspace_id = ?'); params.push(input.workspaceId); }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const totals = store.db.prepare(`SELECT 'all' AS key, ${SUMS} FROM agent_usage u ${clause}`).get(...params) as Aggregate;
  const byAgent = store.db.prepare(`SELECT adapter_id AS key, ${SUMS} FROM agent_usage u ${clause} GROUP BY adapter_id ORDER BY total DESC`).all(...params) as Aggregate[];
  const byProject = store.db.prepare(`SELECT u.workspace_id AS key, w.name AS name, ${SUMS} FROM agent_usage u
    LEFT JOIN workspaces w ON w.id = u.workspace_id ${clause} GROUP BY u.workspace_id ORDER BY total DESC`).all(...params) as (Aggregate & { name: string | null })[];
  const byModel = store.db.prepare(`SELECT adapter_id || ' · ' || COALESCE(model, 'default model') AS key, ${SUMS} FROM agent_usage u ${clause}
    GROUP BY adapter_id, model ORDER BY total DESC LIMIT 20`).all(...params) as Aggregate[];
  const zero = (a: Aggregate): Aggregate => ({ ...a, sessions: a.sessions ?? 0, input: a.input ?? 0, cached: a.cached ?? 0, output: a.output ?? 0, reasoning: a.reasoning ?? 0, total: a.total ?? 0, cost: a.cost ?? null });
  return {
    range: input.range,
    totals: toRow(zero(totals), 'All agents'),
    byAgent: byAgent.map((a) => toRow(zero(a), agentName(a.key))),
    byProject: byProject.map((a) => toRow(zero(a), a.name ?? 'Deleted project')),
    byModel: byModel.map((a) => {
      const [agent, model] = a.key.split(' · ');
      return toRow(zero(a), `${agentName(agent ?? '')} · ${model ?? ''}`);
    }),
  };
}

/** Token totals for one task, overall and per step (the planner has no step). */
export function taskUsage(store: Store, taskId: string): { total: UsageRow | null; byStep: Record<string, UsageRow> } {
  const rows = store.db.prepare(`SELECT COALESCE(step_id, 'planner') AS key, ${SUMS} FROM agent_usage u WHERE task_id = ? GROUP BY step_id`).all(taskId) as Aggregate[];
  if (rows.length === 0) return { total: null, byStep: {} };
  const byStep: Record<string, UsageRow> = {};
  const sum: Aggregate = { key: 'task', sessions: 0, input: 0, cached: 0, output: 0, reasoning: 0, total: 0, cost: null };
  for (const row of rows) {
    byStep[row.key] = toRow({ ...row, cost: row.cost ?? null }, row.key);
    sum.sessions += row.sessions; sum.input += row.input; sum.cached += row.cached; sum.output += row.output;
    sum.reasoning += row.reasoning; sum.total += row.total;
    if (row.cost !== null) sum.cost = (sum.cost ?? 0) + row.cost;
  }
  return { total: toRow(sum, 'This message'), byStep };
}
