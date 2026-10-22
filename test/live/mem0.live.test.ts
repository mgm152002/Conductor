import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SqliteStore } from '@main/db/store';
import { MemoryEngine } from '@main/domain/memory-engine';
import { Mem0Client } from '@main/domain/mem0-client';

// Opt-in: touches only a new test namespace on the real self-hosted service.
const enabled = process.env['RUN_MEM0_LIVE'] === '1';
let store: SqliteStore | undefined;
let root: string | undefined;
let engine: MemoryEngine | undefined;
afterEach(async () => {
  try {
    if (store && engine) {
      store.db.prepare('DELETE FROM memories').run();
      await engine.synchronize();
    }
  } finally {
    store?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

it.skipIf(!enabled)('stores, retrieves by meaning, corrects and deletes through real Mem0', async () => {
  const connectionFile = join(process.env['HOME']!, 'Library/Application Support/Conductor/mem0-connection.json');
  const client = new Mem0Client({ connectionFile, timeoutMs: 30_000 });
  root = mkdtempSync(join(tmpdir(), 'conductor-mem0-live-'));
  store = new SqliteStore(resolve(root, 'workflow.db'));
  await store.migrate();
  engine = new MemoryEngine(store, Date.now, client);
  const commute = await engine.create({ layer: 'project', scope: { level: 'project', refId: 'commute' },
    content: 'Every weekday I travel to the office by train.', provenance: { method: 'user_stated', sourceId: 'user' }, veracity: 'observed_fact' });
  await engine.create({ layer: 'project', scope: { level: 'project', refId: 'commute' },
    content: 'For dessert I bake chocolate cakes and cinnamon cookies.', provenance: { method: 'user_stated', sourceId: 'user' } });
  await engine.create({ layer: 'project', scope: { level: 'project', refId: 'other' },
    content: 'The best commute is cycling to work.', provenance: { method: 'user_stated', sourceId: 'user' } });
  const found = await engine.search({ text: 'How does this person commute to work?', projectId: 'commute' });
  expect(found[0]?.memory.id).toBe(commute.id);
  expect((await engine.inspect(commute.id)).content).toBe(commute.content);
  expect(store.db.prepare('SELECT content FROM memories WHERE id=?').get(commute.id)).toEqual({ content: '' });
  const next = await engine.supersede(commute.id, { layer: commute.layer, scope: commute.scope,
    content: 'I now ride a bicycle to my workplace.', provenance: { method: 'user_stated', sourceId: 'user' } });
  await engine.promoteToFact(next.id, { kind: 'user_correction', sourceId: 'user' });
  const updated = await engine.search({ text: 'How does this person commute?', projectId: 'commute' });
  expect(updated[0]?.memory.id).toBe(next.id);
  expect(updated.map((hit) => hit.memory.id)).not.toContain(commute.id);
  const remote = store.db.prepare('SELECT mem0_id FROM memories WHERE id=?').get(next.id) as { mem0_id: string };
  expect(await engine.delete(next.id)).toEqual({});
  await expect(client.get(remote.mem0_id)).rejects.toMatchObject({ status: 404 });
}, 120_000);
