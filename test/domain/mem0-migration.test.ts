import { describe, it, expect } from 'vitest';
import { SqliteStore } from '@main/db/store';
import { MIGRATIONS } from '@main/db/migrations';
import { MemoryEngine } from '@main/domain/memory-engine';
import { mockMem0 } from '../helpers/mem0';

describe('Mem0 schema migration', () => {
  it('removes full text indexes while retaining legacy content for resumable transfer', async () => {
    const store = new SqliteStore(':memory:');
    await store.migrate();
    try {
      expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name='memories_fts'").get()).toBeUndefined();
      expect(store.db.prepare("PRAGMA table_info(memories)").all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'mem0_id' })]));
    } finally { store.close(); }
  });

  it('retains v18 content during an outage and resumes from a lost POST response', async () => {
    const store = new SqliteStore(':memory:', { migrations: MIGRATIONS.slice(0, 18) });
    await store.migrate();
    store.db.prepare(`INSERT INTO memories(id,layer,content,veracity,confidence,method,scope_level,created_at)
      VALUES('legacy','personal','original legacy text','inferred',0.5,'agent_output','global','2026-01-01T00:00:00Z')`).run();
    MIGRATIONS[18]!.up({ db: store.db });
    const mock = mockMem0();
    const engine = new MemoryEngine(store, Date.now, mock.client);
    try {
      mock.setOffline(true);
      await expect(engine.synchronize()).rejects.toThrow(/unavailable/i);
      expect(store.db.prepare("SELECT content FROM memories WHERE id='legacy'").get()).toEqual({ content: 'original legacy text' });
      mock.setOffline(false);
      mock.loseNextAddResponse();
      await expect(engine.synchronize()).rejects.toThrow(/unavailable/i);
      expect(mock.records.size).toBe(1);
      // Simulate an application restart: no volatile ID or retry state survives.
      const restarted = new MemoryEngine(store, Date.now, mock.client);
      await restarted.synchronize();
      expect(mock.records.size).toBe(1);
      expect(store.db.prepare("SELECT content,mem0_dirty FROM memories WHERE id='legacy'").get()).toEqual({ content: '', mem0_dirty: 0 });
      expect((await restarted.inspect('legacy')).content).toBe('original legacy text');
    } finally { store.close(); }
  });

  it('deletes an unlinked remote write after SQL deletion and an application restart', async () => {
    const store = new SqliteStore(':memory:');
    await store.migrate();
    const mock = mockMem0();
    const engine = new MemoryEngine(store, Date.now, mock.client);
    try {
      mock.loseNextAddResponse();
      await expect(engine.create({ layer: 'personal', scope: { level: 'global' }, content: 'delete even after lost response' })).rejects.toThrow();
      store.db.prepare('DELETE FROM memories').run();
      mock.setOffline(true);
      await expect(engine.synchronize()).rejects.toThrow();
      expect(store.db.prepare('SELECT * FROM mem0_deletions').all()).toHaveLength(1);
      mock.setOffline(false);
      await new MemoryEngine(store, Date.now, mock.client).synchronize();
      expect(mock.records.size).toBe(0);
      expect(store.db.prepare('SELECT * FROM mem0_deletions').all()).toEqual([]);
    } finally { store.close(); }
  });
});
