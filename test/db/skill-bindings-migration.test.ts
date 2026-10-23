import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '@main/db/migrations';
import { SqliteStore } from '@main/db/store';

function insertSkill(store: SqliteStore, skillId: string, name: string): void {
  store.db.prepare(`
    INSERT INTO skills (
      id, name, scope, scope_ref, current_version, created_at, updated_at
    ) VALUES (?, ?, 'global', '', 1, ?, ?)
  `).run(skillId, name, '2026-10-25T00:00:00.000Z', '2026-10-25T00:00:00.000Z');
  store.db.prepare(`
    INSERT INTO skill_versions (
      skill_id, version, purpose, applicability, required_context,
      input_contract, output_contract, steps, tool_requirements,
      failure_handling, verification_criteria, examples,
      provenance_method, provenance_source, created_at
    ) VALUES (?, 1, ?, ?, '[]', '[]', '[]', '[]', '[]', ?, '[]', '[]',
      'agent_output', 'task:test', ?)
  `).run(
    skillId,
    'Extract a vendor invoice',
    'Invoices from the bound vendor',
    'Report fields that cannot be extracted',
    '2026-10-25T00:00:00.000Z',
  );
}

describe('migration 21 — learned skill bindings and usage', () => {
  it('creates binding and usage tables with lookup indexes', async () => {
    const store = new SqliteStore(':memory:');
    await store.migrate();
    try {
      const tables = store.db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('skill_bindings', 'skill_usages')
        ORDER BY name
      `).all();
      expect(tables).toEqual([
        { name: 'skill_bindings' },
        { name: 'skill_usages' },
      ]);

      const indexes = store.db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name IN ('skill_bindings', 'skill_usages')
      `).all() as Array<{ name: string }>;
      expect(indexes.map(({ name }) => name)).toEqual(expect.arrayContaining([
        'idx_skill_bindings_trigger',
        'idx_skill_usages_task',
        'idx_skill_usages_skill_version',
      ]));
    } finally {
      store.close();
    }
  });

  it('allows only one binding for a trigger kind and key', async () => {
    const store = new SqliteStore(':memory:');
    await store.migrate();
    try {
      insertSkill(store, 'skill-a', 'Vendor A invoice');
      insertSkill(store, 'skill-b', 'Vendor B invoice');
      const insert = store.db.prepare(`
        INSERT INTO skill_bindings (
          id, skill_id, trigger_type, trigger_key, trigger_aliases,
          extraction_template, status, created_at, updated_at
        ) VALUES (?, ?, 'vendor', 'acme-001', '[]', '{"fields":[]}', 'active', ?, ?)
      `);
      insert.run('binding-a', 'skill-a', '2026-10-25T00:00:00.000Z', '2026-10-25T00:00:00.000Z');
      expect(() => insert.run(
        'binding-b',
        'skill-b',
        '2026-10-25T00:00:00.000Z',
        '2026-10-25T00:00:00.000Z',
      )).toThrow(/unique/i);
    } finally {
      store.close();
    }
  });

  it('cascades bindings and exact-version usage rows when a skill is deleted', async () => {
    const store = new SqliteStore(':memory:');
    await store.migrate();
    try {
      insertSkill(store, 'skill-a', 'Vendor A invoice');
      store.db.prepare(`
        INSERT INTO skill_bindings (
          id, skill_id, trigger_type, trigger_key, trigger_aliases,
          extraction_template, status, created_at, updated_at
        ) VALUES ('binding-a', 'skill-a', 'vendor', 'acme-001', '[]',
          '{"fields":[]}', 'active', ?, ?)
      `).run('2026-10-25T00:00:00.000Z', '2026-10-25T00:00:00.000Z');
      store.db.prepare(`
        INSERT INTO skill_usages (
          id, binding_id, task_id, skill_id, skill_version, trigger_key,
          outcome, started_at, completed_at
        ) VALUES ('usage-a', 'binding-a', NULL, 'skill-a', 1, 'acme-001',
          'completed', ?, ?)
      `).run('2026-10-25T00:00:00.000Z', '2026-10-25T00:00:01.000Z');

      store.db.prepare("DELETE FROM skills WHERE id = 'skill-a'").run();

      expect(store.db.prepare('SELECT * FROM skill_bindings').all()).toEqual([]);
      expect(store.db.prepare('SELECT * FROM skill_usages').all()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('preserves skills and versions created before migration 21', async () => {
    const store = new SqliteStore(':memory:', { migrations: MIGRATIONS.slice(0, 20) });
    await store.migrate();
    try {
      insertSkill(store, 'existing-skill', 'Existing invoice parser');
      MIGRATIONS[20]!.up({ db: store.db });

      expect(store.db.prepare(`
        SELECT id, name, current_version FROM skills WHERE id = 'existing-skill'
      `).get()).toEqual({
        id: 'existing-skill',
        name: 'Existing invoice parser',
        current_version: 1,
      });
      expect(store.db.prepare(`
        SELECT skill_id, version FROM skill_versions WHERE skill_id = 'existing-skill'
      `).get()).toEqual({ skill_id: 'existing-skill', version: 1 });
    } finally {
      store.close();
    }
  });
});
