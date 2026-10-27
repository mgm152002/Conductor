import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '@main/db/migrations';
import { SqliteStore } from '@main/db/store';

// Migration 26 rebuilds agent_usage_limits so the daily window kind can be
// stored. SQLite cannot edit a CHECK constraint in place, so the migration
// copies every existing snapshot into a new table.

const INSERT_LIMIT = `INSERT INTO agent_usage_limits
  (adapter_id, window_kind, label, remaining_percent, used_percent, resets_at,
   reported_at, source, window_minutes, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

describe('migration 26 — daily quota windows', () => {
  it('preserves existing snapshots and accepts the daily kind', async () => {
    const store = new SqliteStore(':memory:', { migrations: MIGRATIONS.slice(0, 25) });
    await store.migrate();
    try {
      const insert = store.db.prepare(INSERT_LIMIT);
      insert.run(
        'codex', 'session', null, 58, 42, '2026-10-27T13:00:00.000Z',
        '2026-10-27T12:00:00.000Z', 'codex', 300, '2026-10-27T12:00:00.000Z',
      );
      insert.run(
        'antigravity', 'weekly', 'Gemini Models', 10, 90, '2026-11-02T12:00:00.000Z',
        '2026-10-27T12:00:00.000Z', 'antigravity', null, '2026-10-27T12:00:00.000Z',
      );

      MIGRATIONS[25]!.up({ db: store.db });

      expect(store.db.prepare(`
        SELECT adapter_id, window_kind, label, remaining_percent, used_percent,
               resets_at, reported_at, source, window_minutes, updated_at
        FROM agent_usage_limits ORDER BY adapter_id
      `).all()).toEqual([
        {
          adapter_id: 'antigravity',
          window_kind: 'weekly',
          label: 'Gemini Models',
          remaining_percent: 10,
          used_percent: 90,
          resets_at: '2026-11-02T12:00:00.000Z',
          reported_at: '2026-10-27T12:00:00.000Z',
          source: 'antigravity',
          window_minutes: null,
          updated_at: '2026-10-27T12:00:00.000Z',
        },
        {
          adapter_id: 'codex',
          window_kind: 'session',
          label: null,
          remaining_percent: 58,
          used_percent: 42,
          resets_at: '2026-10-27T13:00:00.000Z',
          reported_at: '2026-10-27T12:00:00.000Z',
          source: 'codex',
          window_minutes: 300,
          updated_at: '2026-10-27T12:00:00.000Z',
        },
      ]);

      // The rebuilt table accepts a percentage-less daily window.
      expect(() => store.db.prepare(INSERT_LIMIT).run(
        'opencode', 'daily', 'Free models', null, null, '2026-10-28T00:00:00.000Z',
        '2026-10-27T12:00:00.000Z', 'opencode', 1440, '2026-10-27T12:00:00.000Z',
      )).not.toThrow();
      // Unknown kinds are still rejected.
      expect(() => store.db.prepare(INSERT_LIMIT).run(
        'opencode', 'monthly', null, 50, 50, null,
        '2026-10-27T12:00:00.000Z', 'opencode', null, '2026-10-27T12:00:00.000Z',
      )).toThrow(/CHECK/);

      // The reported-at index is recreated with the table.
      const indexes = store.db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'agent_usage_limits'
      `).all() as Array<{ name: string }>;
      expect(indexes.map(({ name }) => name)).toContain('idx_agent_usage_limits_reported');
    } finally {
      store.close();
    }
  });
});
