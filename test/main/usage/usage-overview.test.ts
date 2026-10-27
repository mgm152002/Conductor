import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteStore } from '@main/db/store';
import { usageSummary } from '@main/usage/usage';
import type { AdapterRecord } from '@shared/domain';
import type { UsageRange } from '@shared/usage';

// Usage overview aggregation: every range boundary, zero-usage attached CLIs,
// and the by-agent / by-project / by-model totals. These tests run against a
// migrated in-memory SQLite store and never invoke a CLI.

const NOW = new Date('2026-10-27T12:00:00.000Z');
const DAY = 86_400_000;

const stores: SqliteStore[] = [];

beforeEach(() => {
  // `usageSummary` derives its cutoff from `Date.now()`; pin it so the range
  // boundaries are exact rather than racing the wall clock.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.useRealTimers();
});

async function freshStore(): Promise<SqliteStore> {
  const store = new SqliteStore(':memory:');
  stores.push(store);
  await store.migrate();
  return store;
}

function insertWorkspace(store: SqliteStore, id: string, name: string): void {
  store.db
    .prepare('INSERT INTO workspaces (id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, name, `/tmp/${id}`, NOW.toISOString(), NOW.toISOString());
}

function insertTask(store: SqliteStore, id: string, workspaceId: string): void {
  store.db
    .prepare(`INSERT INTO tasks (id, workspace_id, objective, state, created_at, updated_at)
      VALUES (?, ?, ?, 'COMPLETED', ?, ?)`)
    .run(id, workspaceId, `task ${id}`, NOW.toISOString(), NOW.toISOString());
}

interface UsageFixture {
  sessionId: string;
  adapterId: string;
  workspaceId: string;
  taskId: string;
  createdAt: string;
  model?: string | null;
  input?: number;
  cached?: number;
  output?: number;
  reasoning?: number;
  total?: number;
  cost?: number | null;
}

function insertUsage(store: SqliteStore, usage: UsageFixture): void {
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  store.db
    .prepare(`INSERT INTO agent_usage (session_id, task_id, step_id, workspace_id, adapter_id, model, input_tokens,
      cached_input_tokens, output_tokens, reasoning_tokens, total_tokens, cost_usd, created_at, updated_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      usage.sessionId,
      usage.taskId,
      usage.workspaceId,
      usage.adapterId,
      usage.model ?? null,
      input,
      usage.cached ?? 0,
      output,
      usage.reasoning ?? 0,
      usage.total ?? input + output,
      usage.cost ?? null,
      usage.createdAt,
      usage.createdAt,
    );
}

function insertLimit(
  store: SqliteStore,
  limit: { adapterId: string; kind: 'session' | 'daily' | 'weekly'; remaining?: number; used?: number; resetsAt?: string; label?: string },
): void {
  store.db
    .prepare(`INSERT INTO agent_usage_limits (adapter_id, window_kind, remaining_percent, used_percent, resets_at,
      reported_at, source, window_minutes, label, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`)
    .run(
      limit.adapterId,
      limit.kind,
      limit.remaining ?? null,
      limit.used ?? null,
      limit.resetsAt ?? null,
      NOW.toISOString(),
      limit.adapterId,
      limit.label ?? null,
      NOW.toISOString(),
    );
}

const NAMES: Record<string, string> = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
  kiro: 'Kiro',
  antigravity: 'Antigravity',
};

function agentName(id: string): string {
  return NAMES[id] ?? id;
}

function adapter(id: string, name: string, cls: AdapterRecord['class'] = 'local_cli_agent'): AdapterRecord {
  return { id, class: cls, name, version: '1.0.0', capabilities: [], available: true, config: {} };
}

const AGENT_NAME = agentName;

/** Five sessions spread across every range, two projects, and four models. */
async function seedSpread(): Promise<SqliteStore> {
  const store = await freshStore();
  insertWorkspace(store, 'w1', 'Alpha');
  insertWorkspace(store, 'w2', 'Beta');
  insertTask(store, 't1', 'w1');
  insertTask(store, 't2', 'w1');
  insertTask(store, 't3', 'w2');
  insertUsage(store, {
    sessionId: 's1', adapterId: 'codex', model: 'gpt-5', workspaceId: 'w1', taskId: 't1',
    createdAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
    input: 100, cached: 10, output: 50, reasoning: 5, total: 150, cost: 0.1,
  });
  insertUsage(store, {
    sessionId: 's2', adapterId: 'claude-code', model: 'sonnet', workspaceId: 'w1', taskId: 't2',
    createdAt: new Date(NOW.getTime() - 2 * DAY).toISOString(),
    input: 200, cached: 20, output: 100, reasoning: 10, total: 300, cost: 0.2,
  });
  insertUsage(store, {
    sessionId: 's3', adapterId: 'codex', model: 'gpt-5', workspaceId: 'w2', taskId: 't3',
    createdAt: new Date(NOW.getTime() - 10 * DAY).toISOString(),
    input: 300, output: 150, total: 450, cost: null,
  });
  insertUsage(store, {
    sessionId: 's4', adapterId: 'opencode', model: null, workspaceId: 'w1', taskId: 't1',
    createdAt: new Date(NOW.getTime() - 45 * DAY).toISOString(),
    input: 400, output: 200, total: 600,
  });
  insertUsage(store, {
    sessionId: 's5', adapterId: 'kiro', model: null, workspaceId: 'w2', taskId: 't3',
    createdAt: new Date(NOW.getTime() - 200 * DAY).toISOString(),
    input: 500, output: 250, total: 750,
  });
  return store;
}

describe('usage ranges', () => {
  it.each([
    ['24h', 1],
    ['7d', 7],
    ['30d', 30],
    ['90d', 90],
  ] as const)('includes a row exactly on the %s cutoff and excludes the row just older', async (range, days) => {
    const store = await freshStore();
    insertWorkspace(store, 'w1', 'Alpha');
    insertTask(store, 't1', 'w1');
    insertUsage(store, {
      sessionId: 'exact', adapterId: 'codex', workspaceId: 'w1', taskId: 't1',
      createdAt: new Date(NOW.getTime() - days * DAY).toISOString(), total: 10,
    });
    insertUsage(store, {
      sessionId: 'older', adapterId: 'codex', workspaceId: 'w1', taskId: 't1',
      createdAt: new Date(NOW.getTime() - days * DAY - 1).toISOString(), total: 20,
    });

    const summary = usageSummary(store, { range }, AGENT_NAME);

    expect(summary.range).toBe(range);
    expect(summary.totals.sessions).toBe(1);
    expect(summary.totals.totalTokens).toBe(10);
  });

  it('narrows the totals for 24h, 7d, 30d, and 90d, then includes everything for all', async () => {
    const store = await seedSpread();
    const expected: { range: UsageRange; sessions: number; totalTokens: number }[] = [
      { range: '24h', sessions: 1, totalTokens: 150 },
      { range: '7d', sessions: 2, totalTokens: 450 },
      { range: '30d', sessions: 3, totalTokens: 900 },
      { range: '90d', sessions: 4, totalTokens: 1500 },
      { range: 'all', sessions: 5, totalTokens: 2250 },
    ];

    for (const { range, ...totals } of expected) {
      const summary = usageSummary(store, { range }, AGENT_NAME);
      expect({ sessions: summary.totals.sessions, totalTokens: summary.totals.totalTokens }).toEqual(totals);
    }
  });

  it('aggregates input, cached, output, reasoning, and cost for all time', async () => {
    const store = await seedSpread();
    const summary = usageSummary(store, { range: 'all' }, AGENT_NAME);

    expect(summary.totals).toMatchObject({
      key: 'all',
      label: 'All agents',
      sessions: 5,
      inputTokens: 1500,
      cachedInputTokens: 30,
      outputTokens: 750,
      reasoningTokens: 15,
      totalTokens: 2250,
    });
    expect(summary.totals.costUsd).toBeCloseTo(0.3, 10);
  });

  it('scopes the totals to a workspace when one is given', async () => {
    const store = await seedSpread();
    const summary = usageSummary(store, { range: 'all', workspaceId: 'w2' }, AGENT_NAME);

    expect(summary.totals.sessions).toBe(2);
    expect(summary.totals.totalTokens).toBe(1200);
  });
});

describe('attached CLI clients', () => {
  it('lists every attached local CLI, including one with zero usage', async () => {
    const store = await seedSpread();
    insertLimit(store, { adapterId: 'codex', kind: 'session', remaining: 12, resetsAt: new Date(NOW.getTime() + DAY).toISOString() });
    const adapters = [
      adapter('codex', 'Codex'),
      adapter('claude-code', 'Claude Code'),
      adapter('antigravity', 'Antigravity'),
      adapter('openai', 'OpenAI', 'model_provider'),
    ];

    const summary = usageSummary(store, { range: 'all' }, AGENT_NAME, { adapters });
    const byId = new Map(summary.clients.map((client) => [client.key, client]));

    // A non-CLI adapter class is not an attached CLI.
    expect(byId.has('openai')).toBe(false);

    expect(byId.get('codex')).toMatchObject({ label: 'Codex', sessions: 2, totalTokens: 600 });
    expect(byId.get('claude-code')).toMatchObject({ label: 'Claude Code', sessions: 1, totalTokens: 300 });

    // Attached but unused: a real zero row, not a missing entry.
    expect(byId.get('antigravity')).toMatchObject({
      label: 'Antigravity',
      sessions: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      limits: [],
    });
    expect(byId.get('antigravity')?.costUsd).toBeUndefined();
  });

  it('keeps historical usage from an adapter that is no longer attached', async () => {
    const store = await seedSpread();
    const summary = usageSummary(store, { range: 'all' }, AGENT_NAME, { adapters: [adapter('codex', 'Codex')] });

    const labels = summary.clients.map((client) => client.label).sort();
    expect(labels).toEqual(['Claude Code', 'Codex', 'Kiro', 'OpenCode']);
    expect(summary.clients.find((client) => client.key === 'kiro')).toMatchObject({ sessions: 1, totalTokens: 750 });
  });

  it('sorts clients by total tokens and then by label', async () => {
    const store = await seedSpread();
    const summary = usageSummary(store, { range: 'all' }, AGENT_NAME);

    expect(summary.clients.map((client) => client.key)).toEqual(['kiro', 'codex', 'opencode', 'claude-code']);
  });

  it('attaches only current limit windows and leaves unreported CLIs empty', async () => {
    const store = await seedSpread();
    const dailyReset = new Date(NOW.getTime() + 6 * 3_600_000).toISOString();
    insertLimit(store, { adapterId: 'codex', kind: 'session', remaining: 12, resetsAt: new Date(NOW.getTime() + 3_600_000).toISOString() });
    insertLimit(store, { adapterId: 'codex', kind: 'weekly', remaining: 88, resetsAt: new Date(NOW.getTime() - 1_000).toISOString() });
    insertLimit(store, { adapterId: 'claude-code', kind: 'weekly', used: 30, label: 'All models' });
    insertLimit(store, { adapterId: 'opencode', kind: 'daily', resetsAt: dailyReset });
    const adapters = [adapter('codex', 'Codex'), adapter('claude-code', 'Claude Code'), adapter('antigravity', 'Antigravity')];

    const summary = usageSummary(store, { range: 'all' }, AGENT_NAME, { adapters });
    const byId = new Map(summary.clients.map((client) => [client.key, client]));

    // The stale weekly reset is dropped; the live session window stays.
    expect(byId.get('codex')?.limits).toEqual([
      { kind: 'session', remainingPercent: 12, resetsAt: new Date(NOW.getTime() + 3_600_000).toISOString(), reportedAt: NOW.toISOString(), source: 'codex' },
    ]);
    expect(byId.get('claude-code')?.limits).toEqual([
      { kind: 'weekly', usedPercent: 30, reportedAt: NOW.toISOString(), source: 'claude-code', label: 'All models' },
    ]);
    // A known window with no reported percentage keeps its reset and neither
    // percentage, rather than inventing 0 or 100.
    expect(byId.get('opencode')?.limits).toEqual([
      { kind: 'daily', resetsAt: dailyReset, reportedAt: NOW.toISOString(), source: 'opencode' },
    ]);
    expect(byId.get('antigravity')?.limits).toEqual([]);
  });

  it('orders a client’s current limits as session, daily, then weekly', async () => {
    const store = await seedSpread();
    const reset = new Date(NOW.getTime() + 3_600_000).toISOString();
    insertLimit(store, { adapterId: 'opencode', kind: 'weekly', remaining: 50, resetsAt: reset });
    insertLimit(store, { adapterId: 'opencode', kind: 'daily', remaining: 25, resetsAt: reset });
    insertLimit(store, { adapterId: 'opencode', kind: 'session', remaining: 75, resetsAt: reset });

    const summary = usageSummary(store, { range: 'all' }, AGENT_NAME);

    expect(summary.clients.find((client) => client.key === 'opencode')?.limits.map((limit) => limit.kind))
      .toEqual(['session', 'daily', 'weekly']);
  });
});

describe('breakdown totals', () => {
  it('keeps by-agent totals for adapters with usage only', async () => {
    const store = await seedSpread();
    const summary = usageSummary(store, { range: 'all' }, AGENT_NAME, { adapters: [adapter('antigravity', 'Antigravity')] });

    const byAgent = Object.fromEntries(
      summary.byAgent.map((row) => [row.label, { sessions: row.sessions, totalTokens: row.totalTokens }]),
    );

    expect(byAgent).toEqual({
      Kiro: { sessions: 1, totalTokens: 750 },
      Codex: { sessions: 2, totalTokens: 600 },
      OpenCode: { sessions: 1, totalTokens: 600 },
      'Claude Code': { sessions: 1, totalTokens: 300 },
    });
    // Zero-usage attached CLIs are on `clients`, not invented into `byAgent`.
    expect(summary.byAgent.some((row) => row.label === 'Antigravity')).toBe(false);
  });

  it('groups by project with workspace names and falls back for deleted projects', async () => {
    const store = await seedSpread();
    // A usage row whose workspace was deleted: the LEFT JOIN yields no name.
    insertUsage(store, {
      sessionId: 's6', adapterId: 'codex', workspaceId: 'gone', taskId: 't1',
      createdAt: NOW.toISOString(), total: 100,
    });
    const summary = usageSummary(store, { range: 'all' }, AGENT_NAME);
    const byProject = Object.fromEntries(summary.byProject.map((row) => [row.label, row]));

    expect(byProject['Beta']).toMatchObject({ key: 'w2', sessions: 2, totalTokens: 1200 });
    expect(byProject['Alpha']).toMatchObject({ key: 'w1', sessions: 3, totalTokens: 1050 });
    expect(byProject['Deleted project']).toMatchObject({ key: 'gone', sessions: 1, totalTokens: 100 });
  });

  it('groups by adapter and model, naming the default model when none was reported', async () => {
    const store = await seedSpread();
    const summary = usageSummary(store, { range: 'all' }, AGENT_NAME);
    const byModel = Object.fromEntries(summary.byModel.map((row) => [row.label, row]));

    expect(byModel['Codex · gpt-5']).toMatchObject({ sessions: 2, totalTokens: 600 });
    expect(byModel['Claude Code · sonnet']).toMatchObject({ sessions: 1, totalTokens: 300 });
    expect(byModel['OpenCode · default model']).toMatchObject({ sessions: 1, totalTokens: 600 });
    expect(byModel['Kiro · default model']).toMatchObject({ sessions: 1, totalTokens: 750 });
    expect(summary.byModel).toHaveLength(4);
  });
});
