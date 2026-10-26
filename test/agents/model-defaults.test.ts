import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '@main/db/store';
import { SettingsService } from '@main/domain/settings-service';
import { WorkspaceService } from '@main/domain/workspace-service';
import { RunResolver } from '@main/agents/run-resolver';
import { chooseRun } from '@main/agents/model-routing';
import type { ModelCatalogService } from '@main/agents/model-catalog';
import type { AgentModelCatalog } from '@shared/agent-models';
import type { Task } from '@shared/domain';
import {
  defaultModelKey,
  fallbackModelKey,
  isValidModelId,
  MODEL_ID_REGEX,
} from '@shared/model-defaults';

const stores: SqliteStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function createSettingsEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'conductor-model-defaults-'));
  tempDirs.push(dir);
  const store = new SqliteStore(join(dir, 'test.db'));
  stores.push(store);
  await store.migrate();
  const workspaces = new WorkspaceService(store);
  const settings = new SettingsService(store, workspaces);
  return { dir, store, workspaces, settings };
}

const sampleCatalog: AgentModelCatalog = {
  agentId: 'codex',
  source: 'cli',
  efforts: ['low', 'medium', 'high'],
  models: [
    { id: 'gpt-6-astra', label: 'GPT-6 Astra', tier: 'premium', isDefault: true, efforts: ['low', 'medium', 'high'] },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', tier: 'balanced', efforts: ['low', 'medium', 'high'] },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', tier: 'economy', efforts: ['low', 'medium', 'high'] },
  ],
};

describe('model-defaults contract', () => {
  describe('key builders', () => {
    it('builds settings keys for default and fallback models per agent', () => {
      expect(defaultModelKey('codex')).toBe('agents.codex.model');
      expect(fallbackModelKey('codex')).toBe('agents.codex.fallbackModel');
      expect(defaultModelKey('opencode')).toBe('agents.opencode.model');
      expect(fallbackModelKey('opencode')).toBe('agents.opencode.fallbackModel');
      expect(defaultModelKey('claude-code')).toBe('agents.claude-code.model');
      expect(fallbackModelKey('claude-code')).toBe('agents.claude-code.fallbackModel');
      expect(defaultModelKey('antigravity')).toBe('agents.antigravity.model');
      expect(fallbackModelKey('antigravity')).toBe('agents.antigravity.fallbackModel');
    });
  });

  describe('model ID validation', () => {
    it('accepts valid model IDs', () => {
      const valid = [
        'gpt-5.6-luna',
        'gpt-6-astra',
        'claude-3-7-sonnet',
        'claude-opus-4-6',
        'gemini-3.8-flash-high',
        'gemini-2.5-pro',
        'openai/gpt-4o',
        'models/gemini-2.0-flash',
        'deepseek-ai/DeepSeek-R1',
        'meta-llama/llama-3.1-70b-instruct',
        'vendor:custom-model@v2',
        'model.with.dots',
        'simple_name_123',
        'x',
        'a'.repeat(100),
      ];
      for (const id of valid) {
        expect(isValidModelId(id), `expected "${id}" to be valid`).toBe(true);
        expect(MODEL_ID_REGEX.test(id), `regex test for "${id}"`).toBe(true);
      }
    });

    it('rejects invalid model IDs', () => {
      const invalid = [
        '',
        '   ',
        'gpt 5.6 luna',
        'gpt-5.6-luna ',
        ' gpt-5.6-luna',
        'model;rm -rf /',
        'model$(whoami)',
        'model`id`',
        'bad$model',
        'bad#model',
        'bad%model',
        'bad&model',
        'bad?model',
        'bad!model',
        'bad*model',
        'bad<model>',
        'bad"model"',
        "bad'model'",
        'line1\nline2',
        'tab\tmodel',
        'a'.repeat(101),
      ];
      for (const id of invalid) {
        expect(isValidModelId(id), `expected "${id}" to be invalid`).toBe(false);
        expect(MODEL_ID_REGEX.test(id), `regex test for "${id}"`).toBe(false);
      }
    });
  });

  describe('settings persistence and validation (Requirements 1.2, 1.3)', () => {
    it('persists default and fallback models under agents.<id>.model and agents.<id>.fallbackModel at global scope', async () => {
      const { settings } = await createSettingsEnv();

      settings.set({ key: defaultModelKey('codex'), value: 'gpt-5.6-luna', scope: 'global' });
      settings.set({ key: fallbackModelKey('codex'), value: 'gpt-5.6-sol', scope: 'global' });

      expect(settings.resolve(defaultModelKey('codex'))).toBe('gpt-5.6-luna');
      expect(settings.resolve(fallbackModelKey('codex'))).toBe('gpt-5.6-sol');
    });

    it('validates model ID and ignores invalid values in RunResolver', async () => {
      const { store, settings } = await createSettingsEnv();
      const resolver = new RunResolver(store, settings, undefined);

      // Valid fallback model resolves
      settings.set({ key: fallbackModelKey('codex'), value: 'gpt-5.6-sol', scope: 'global' });
      expect(resolver.fallbackModel('codex')).toBe('gpt-5.6-sol');

      // Invalid fallback model with invalid characters returns undefined
      settings.set({ key: fallbackModelKey('codex'), value: 'bad model name with spaces', scope: 'global' });
      expect(resolver.fallbackModel('codex')).toBeUndefined();

      // Empty fallback model returns undefined
      settings.set({ key: fallbackModelKey('codex'), value: '   ', scope: 'global' });
      expect(resolver.fallbackModel('codex')).toBeUndefined();

      // Over-long fallback model returns undefined
      settings.set({ key: fallbackModelKey('codex'), value: 'x'.repeat(101), scope: 'global' });
      expect(resolver.fallbackModel('codex')).toBeUndefined();
    });
  });

  describe('default precedence', () => {
    it('prefers composer explicit choice over Settings default and Auto', () => {
      const run = chooseRun({
        catalog: sampleCatalog,
        difficulty: 'simple',
        explicit: { model: 'gpt-6-astra', effort: 'high' },
        settings: { model: 'gpt-5.6-sol', effort: 'low' },
      });
      expect(run).toMatchObject({
        model: 'gpt-6-astra',
        effort: 'high',
        source: 'composer',
      });
    });

    it('prefers Settings default over Auto when no composer choice is given', () => {
      const run = chooseRun({
        catalog: sampleCatalog,
        difficulty: 'simple',
        settings: { model: 'gpt-5.6-sol', effort: 'medium' },
      });
      expect(run).toMatchObject({
        model: 'gpt-5.6-sol',
        effort: 'medium',
        source: 'settings',
      });
    });

    it('falls back to Auto difficulty-based selection when neither composer nor Settings specifies a model', () => {
      const simpleRun = chooseRun({
        catalog: sampleCatalog,
        difficulty: 'simple',
      });
      expect(simpleRun).toMatchObject({
        model: 'gpt-5.6-luna',
        effort: 'low',
        source: 'auto',
      });

      const complexRun = chooseRun({
        catalog: sampleCatalog,
        difficulty: 'complex',
      });
      expect(complexRun).toMatchObject({
        model: 'gpt-6-astra',
        effort: 'medium',
        source: 'auto',
      });
    });
  });

  describe('fallback selection', () => {
    it('never uses fallback model on the first attempt (useFallback is omitted or false)', () => {
      // With explicit composer choice
      const explicitRun = chooseRun({
        catalog: sampleCatalog,
        difficulty: 'simple',
        explicit: { model: 'gpt-6-astra' },
        settings: { model: 'gpt-5.6-sol' },
        fallback: { model: 'gpt-5.6-luna' },
        useFallback: false,
      });
      expect(explicitRun.model).toBe('gpt-6-astra');
      expect(explicitRun.source).toBe('composer');

      // With settings default
      const settingsRun = chooseRun({
        catalog: sampleCatalog,
        difficulty: 'simple',
        settings: { model: 'gpt-5.6-sol' },
        fallback: { model: 'gpt-5.6-luna' },
      });
      expect(settingsRun.model).toBe('gpt-5.6-sol');
      expect(settingsRun.source).toBe('settings');

      // With Auto
      const autoRun = chooseRun({
        catalog: sampleCatalog,
        difficulty: 'complex',
        fallback: { model: 'gpt-5.6-luna' },
      });
      expect(autoRun.model).toBe('gpt-6-astra');
      expect(autoRun.source).toBe('auto');
    });

    it('uses fallback model when useFallback is true', () => {
      const run = chooseRun({
        catalog: sampleCatalog,
        difficulty: 'simple',
        explicit: { model: 'gpt-6-astra' },
        settings: { model: 'gpt-5.6-sol' },
        fallback: { model: 'gpt-5.6-luna' },
        useFallback: true,
      });
      expect(run).toMatchObject({
        model: 'gpt-5.6-luna',
        source: 'settings',
      });
    });

    it('falls back to primary model/settings if useFallback is true but no fallback model is provided', () => {
      const run = chooseRun({
        catalog: sampleCatalog,
        difficulty: 'simple',
        settings: { model: 'gpt-5.6-sol' },
        useFallback: true,
      });
      expect(run).toMatchObject({
        model: 'gpt-5.6-sol',
        source: 'settings',
      });
    });

    it('honors fallback effort when specified, otherwise retains primary effort if supported', () => {
      const withFallbackEffort = chooseRun({
        catalog: sampleCatalog,
        difficulty: 'simple',
        fallback: { model: 'gpt-5.6-sol', effort: 'high' },
        useFallback: true,
      });
      expect(withFallbackEffort).toMatchObject({
        model: 'gpt-5.6-sol',
        effort: 'high',
        source: 'settings',
      });

      const withPrimaryEffort = chooseRun({
        catalog: sampleCatalog,
        difficulty: 'simple',
        settings: { model: 'gpt-6-astra', effort: 'low' },
        fallback: { model: 'gpt-5.6-sol' },
        useFallback: true,
      });
      expect(withPrimaryEffort).toMatchObject({
        model: 'gpt-5.6-sol',
        effort: 'low',
        source: 'settings',
      });
    });
  });

  describe('RunResolver with Settings defaults and fallback', () => {
    it('applies Settings default model to runnable agents when no composer choice exists', async () => {
      const { store, settings } = await createSettingsEnv();
      const now = new Date().toISOString();
      store.db.prepare(`INSERT INTO workspaces (id, name, root_path, created_at, updated_at) VALUES ('w1', 'W', '/tmp', ?, ?)`).run(now, now);
      store.db.prepare(`INSERT INTO tasks (id, workspace_id, objective, state, created_at, updated_at) VALUES ('t1', 'w1', 'simple question', 'CREATED', ?, ?)`).run(now, now);

      settings.set({ key: defaultModelKey('codex'), value: 'gpt-5.6-sol', scope: 'global' });
      settings.set({ key: fallbackModelKey('codex'), value: 'gpt-5.6-luna', scope: 'global' });

      const catalogs = { cached: (id: string) => (id === 'codex' ? sampleCatalog : undefined) } as unknown as ModelCatalogService;
      const resolver = new RunResolver(store, settings, catalogs);
      const task = { id: 't1', objective: 'simple question' } as Task;

      const resolved = resolver.resolve(task, { role: 'main', agents: ['codex'] });
      expect(resolved.models?.['codex']).toBe('gpt-5.6-sol');
      expect(resolved.runs['codex']?.source).toBe('settings');

      // Fallback model can be queried via resolver
      expect(resolver.fallbackModel('codex')).toBe('gpt-5.6-luna');
    });

    it('composer explicit choice in task still overrides Settings default', async () => {
      const { store, settings } = await createSettingsEnv();
      const now = new Date().toISOString();
      store.db.prepare(`INSERT INTO workspaces (id, name, root_path, created_at, updated_at) VALUES ('w1', 'W', '/tmp', ?, ?)`).run(now, now);
      store.db.prepare(`INSERT INTO tasks (id, workspace_id, objective, state, created_at, updated_at) VALUES ('t1', 'w1', 'simple question', 'CREATED', ?, ?)`).run(now, now);

      settings.set({ key: defaultModelKey('codex'), value: 'gpt-5.6-sol', scope: 'global' });

      const catalogs = { cached: (id: string) => (id === 'codex' ? sampleCatalog : undefined) } as unknown as ModelCatalogService;
      const resolver = new RunResolver(store, settings, catalogs);
      const task = { id: 't1', objective: 'simple question' } as Task;

      resolver.save('t1', { main: { model: 'gpt-6-astra', effort: 'high' } });
      const resolved = resolver.resolve(task, { role: 'main', agents: ['codex'] });
      expect(resolved.models?.['codex']).toBe('gpt-6-astra');
      expect(resolved.efforts?.['codex']).toBe('high');
      expect(resolved.runs['codex']?.source).toBe('composer');
    });
  });
});
