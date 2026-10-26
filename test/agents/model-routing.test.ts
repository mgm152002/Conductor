import { describe, expect, it } from 'vitest';
import type { AgentModelCatalog } from '@shared/agent-models';
import { assessDifficulty, chooseRun, modelTier, nearestEffort } from '@main/agents/model-routing';
import { capContext } from '@main/agents/context-budget';
import { parseRunOptions, RunResolver } from '@main/agents/run-resolver';
import type { ModelCatalogService } from '@main/agents/model-catalog';
import { SqliteStore } from '@main/db/store';
import type { Task } from '@shared/domain';

// Codex's real model list (codex 0.153.4, ChatGPT account).
const codex: AgentModelCatalog = {
  agentId: 'codex', source: 'cli', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  models: [
    { id: 'gpt-6-astra', label: 'GPT-6-Astra', description: 'Frontier intelligence for the most demanding work.', tier: 'premium', isDefault: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', description: 'Older generation workhorse model.', tier: 'balanced', efforts: ['low', 'medium', 'high'] },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', description: 'Older balanced model for straightforward work.', tier: 'balanced', efforts: ['low', 'medium', 'high'] },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', description: 'Older fast and efficient model.', tier: 'economy', efforts: ['low', 'medium', 'high'] },
  ],
};

describe('difficulty', () => {
  it.each([
    ['what is this folder about give me some context', 'simple'],
    ['Explain how the scheduler works?', 'simple'],
    ['run the tests', 'simple'],
    ['add a dark mode toggle to settings', 'moderate'],
    ['fix the typo in README', 'moderate'],
    ['Implement OAuth login across the codebase, migrate the user table, then add tests and finally deploy', 'complex'],
    ['Build a todo app with a REST API and a React frontend', 'complex'],
  ] as const)('%s → %s', (objective, expected) => {
    expect(assessDifficulty(objective)).toBe(expected);
  });
});

describe('model choice', () => {
  it('classifies model cost from names and descriptions', () => {
    expect(codex.models.map((m) => modelTier(m))).toEqual(['premium', 'balanced', 'balanced', 'economy']);
    expect(['gemini-3.8-flash-low', 'claude-opus-4-6-thinking', 'gemini-3.8-flash-medium'].map((id) => modelTier({ id }))).toEqual(['economy', 'premium', 'balanced']);
    expect(modelTier({ id: 'haiku' })).toBe('economy');
  });

  it('routes by difficulty on Auto: cheap and low effort for quick requests', () => {
    expect(chooseRun({ catalog: codex, difficulty: 'simple' })).toEqual({ model: 'gpt-5.6-luna', effort: 'low', source: 'auto', difficulty: 'simple' });
    expect(chooseRun({ catalog: codex, difficulty: 'moderate' })).toMatchObject({ model: 'gpt-5.6-sol', effort: 'medium' });
    expect(chooseRun({ catalog: codex, difficulty: 'complex' })).toMatchObject({ model: 'gpt-6-astra', effort: 'medium' });
  });

  it('prefers the composer, then Settings, over Auto', () => {
    expect(chooseRun({ catalog: codex, difficulty: 'simple', settings: { model: 'gpt-5.6-sol' }, explicit: { effort: 'high' } }))
      .toEqual({ model: 'gpt-5.6-sol', effort: 'high', source: 'composer', difficulty: 'simple' });
    expect(chooseRun({ catalog: codex, difficulty: 'complex', settings: { model: 'gpt-5.6-terra' } })).toMatchObject({ model: 'gpt-5.6-terra', effort: 'medium', source: 'settings' });
    // Without a model list, Auto leaves the CLI's default alone.
    expect(chooseRun({ catalog: undefined, difficulty: 'simple' })).toEqual({ source: 'default', difficulty: 'simple' });
  });

  it('snaps to a supported effort', () => {
    expect(nearestEffort('low', ['minimal', 'medium', 'high'])).toBe('minimal');
    expect(nearestEffort('medium', ['low', 'high'])).toBe('low');
    expect(nearestEffort('low', [])).toBeUndefined();
  });

  it('validates composer choices', () => {
    expect(parseRunOptions({ main: { model: 'gpt-5.6-luna', effort: 'low' }, mainAgentId: 'opencode', agents: { antigravity: { effort: 'high' }, 'bad id!': { model: 'x' }, kiro: { model: 'a b' } } }))
      .toEqual({ main: { model: 'gpt-5.6-luna', effort: 'low' }, mainAgentId: 'opencode', agents: { antigravity: { effort: 'high' } } });
  });

  // Antigravity-style catalog: `--effort` works only for its native Gemini
  // models, so effort is attached per model; others carry none.
  const perModel: AgentModelCatalog = {
    agentId: 'mixed', source: 'cli', efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    models: [
      { id: 'reasoner-pro', label: 'Reasoner Pro', tier: 'premium', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'proxied-4-6', label: 'Proxied 4.6', tier: 'balanced' },
    ],
  };

  it('never sends effort to a model that does not support it', () => {
    // A pinned model with no per-model efforts must not receive `--effort`,
    // even when the user or Settings asked for one.
    expect(chooseRun({ catalog: perModel, difficulty: 'complex', explicit: { model: 'proxied-4-6', effort: 'medium' } }))
      .toEqual({ model: 'proxied-4-6', source: 'composer', difficulty: 'complex' });
    expect(chooseRun({ catalog: perModel, difficulty: 'moderate', settings: { model: 'proxied-4-6', effort: 'high' } }))
      .toEqual({ model: 'proxied-4-6', source: 'settings', difficulty: 'moderate' });
    // An effort-capable model still gets one.
    expect(chooseRun({ catalog: perModel, difficulty: 'complex', explicit: { model: 'reasoner-pro', effort: 'high' } }))
      .toMatchObject({ model: 'reasoner-pro', effort: 'high' });
    // A model absent from the catalog (custom slug) gets no assumed effort.
    expect(chooseRun({ catalog: perModel, difficulty: 'complex', explicit: { model: 'custom-x', effort: 'high' } }))
      .toEqual({ model: 'custom-x', source: 'composer', difficulty: 'complex' });
  });

  it('never sends a separate effort when the model id already names one', () => {
    // Some catalogs expose an effort-capable model whose variant id already
    // encodes the effort. The id wins; `--model …-high --effort medium`
    // would be rejected by the CLI.
    const suffixed: AgentModelCatalog = {
      agentId: 'suffixed', source: 'cli', efforts: ['low', 'medium', 'high'],
      models: [
        { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (high)', tier: 'premium', efforts: ['low', 'medium', 'high'] },
      ],
    };
    expect(chooseRun({ catalog: suffixed, difficulty: 'complex', explicit: { model: 'gemini-3.8-flash-high', effort: 'medium' } }))
      .toEqual({ model: 'gemini-3.8-flash-high', source: 'composer', difficulty: 'complex' });
    expect(chooseRun({ catalog: suffixed, difficulty: 'complex' })).not.toHaveProperty('effort');
  });

  it('never sends a separate effort for Antigravity (effort is baked into the model id)', () => {
    // Antigravity exposes "…-low" / "…-high" variants and no `--effort` flag,
    // so its catalog advertises no efforts and a pinned/requested effort is
    // dropped rather than conflicting with `--model`.
    const antigravity: AgentModelCatalog = {
      agentId: 'antigravity', source: 'cli', efforts: [],
      models: [
        { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (low)', tier: 'economy' },
        { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (high)', tier: 'premium' },
      ],
    };
    expect(chooseRun({ catalog: antigravity, difficulty: 'complex', explicit: { model: 'gemini-3.8-flash-high', effort: 'medium' } }))
      .toEqual({ model: 'gemini-3.8-flash-high', source: 'composer', difficulty: 'complex' });
    // Auto on Antigravity picks a model but never an effort.
    expect(chooseRun({ catalog: antigravity, difficulty: 'simple' })).not.toHaveProperty('effort');
  });
});

describe('RunResolver', () => {
  it('applies composer choices to the planner and per sub-agent, Auto otherwise', async () => {
    const store = new SqliteStore(':memory:');
    await store.migrate();
    const now = new Date().toISOString();
    store.db.prepare(`INSERT INTO workspaces (id, name, root_path, created_at, updated_at) VALUES ('w', 'W', '/tmp', ?, ?)`).run(now, now);
    store.db.prepare(`INSERT INTO tasks (id, workspace_id, objective, state, created_at, updated_at) VALUES ('t', 'w', 'what is this?', 'CREATED', ?, ?)`).run(now, now);
    const catalogs = { cached: (id: string) => (id === 'codex' ? codex : undefined) } as unknown as ModelCatalogService;
    const resolver = new RunResolver(store, undefined, catalogs);
    const task = { id: 't', objective: 'what is this?' } as Task;
    expect(resolver.resolve(task, { role: 'main', agents: ['codex'] })).toMatchObject({ models: { codex: 'gpt-5.6-luna' }, efforts: { codex: 'low' } });
    resolver.save('t', { main: { model: 'gpt-6-astra', effort: 'high' }, agents: { codex: { effort: 'medium' } } });
    expect(resolver.resolve(task, { role: 'main', agents: ['codex'] })).toMatchObject({ models: { codex: 'gpt-6-astra' }, efforts: { codex: 'high' }, runs: { codex: { source: 'composer' } } });
    expect(resolver.resolve(task, { role: 'subagent', difficulty: 'complex', agents: ['codex'] })).toMatchObject({ models: { codex: 'gpt-6-astra' }, efforts: { codex: 'medium' } });
    store.close();
  });

  it('does not pass a selected CLI model to a fallback provider', async () => {
    const store = new SqliteStore(':memory:');
    await store.migrate();
    const now = new Date().toISOString();
    store.db.prepare(`INSERT INTO workspaces (id, name, root_path, created_at, updated_at) VALUES ('w', 'W', '/tmp', ?, ?)`).run(now, now);
    store.db.prepare(`INSERT INTO tasks (id, workspace_id, objective, state, created_at, updated_at) VALUES ('t', 'w', 'build the feature', 'CREATED', ?, ?)`).run(now, now);
    const resolver = new RunResolver(store, undefined, undefined);
    const task = { id: 't', objective: 'build the feature' } as Task;
    resolver.save('t', { main: { model: 'opencode/deepseek-v4.1-flash-free' } }, 'opencode');

    expect(resolver.resolve(task, { role: 'main', agents: ['opencode'] }).models)
      .toEqual({ opencode: 'opencode/deepseek-v4.1-flash-free' });
    expect(resolver.resolve(task, { role: 'main', agents: ['antigravity'] }).models)
      .toBeUndefined();
    expect(resolver.resolve(task, { role: 'main', agents: ['antigravity'] }).runs.antigravity?.source)
      .toBe('default');
    store.close();
  });
});

describe('context budget', () => {
  it('keeps context within the budget and trims long items', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, content: 'x'.repeat(3000) }));
    const kept = capContext(items, 4000);
    expect(kept.length).toBe(2);
    expect(String(kept[0]!['content']).length).toBeLessThan(1600);
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(4000);
  });
});
