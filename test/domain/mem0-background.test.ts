import { it, expect, vi } from 'vitest';
import { SqliteStore } from '@main/db/store';
import { MemoryEngine } from '@main/domain/memory-engine';
import { mockMem0 } from '../helpers/mem0';

it('retries pending remote deletion while the app stays open, and stops scheduling on shutdown', async () => {
  vi.useFakeTimers();
  const store = new SqliteStore(':memory:');
  await store.migrate();
  const mock = mockMem0();
  const memory = new MemoryEngine(store, Date.now, mock.client);
  let stop = () => {};
  try {
    const m = await memory.create({ layer: 'personal', scope: { level: 'global' }, content: 'erase later' });
    mock.setOffline(true);
    expect(await memory.delete(m.id)).toEqual({ memoryCleanupPending: true });
    const errors: unknown[] = [];
    stop = memory.startBackgroundSync((error) => errors.push(error), 100);
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toHaveLength(1);
    mock.setOffline(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(mock.records.size).toBe(0);
    expect(store.db.prepare('SELECT * FROM mem0_deletions').all()).toHaveLength(0);
    stop();
    const calls = mock.requests.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(mock.requests).toHaveLength(calls);
  } finally { stop(); vi.useRealTimers(); store.close(); }
});
