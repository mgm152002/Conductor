import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { SqliteStore } from '@main/db/store';
import { WorkspaceService } from '@main/domain/workspace-service';
import { renameThread } from '@main/domain/thread-rename';

let root: string | undefined;
let store: SqliteStore | undefined;
afterEach(() => { store?.close(); if (root) rmSync(root, { recursive: true, force: true }); });

async function seed() {
  root = mkdtempSync(join(tmpdir(), 'conductor-rename-thread-'));
  store = new SqliteStore(':memory:');
  await store.migrate();
  const s = store;
  const project = new WorkspaceService(s).create({ name: 'Project', rootPath: root });
  const now = new Date().toISOString();
  const addTask = (threadId: string | null, objective: string): string => {
    const id = randomUUID();
    s.db.prepare(`INSERT INTO tasks (id, workspace_id, objective, state, thread_id, created_at, updated_at) VALUES (?, ?, ?, 'COMPLETED', ?, ?, ?)`)
      .run(id, project.id, objective, threadId, now, now);
    return id;
  };
  const rootTask = addTask(null, 'Original first message');
  s.db.prepare('UPDATE tasks SET thread_id = ? WHERE id = ?').run(rootTask, rootTask);
  const followUp = addTask(rootTask, 'Follow up');
  return { s, rootTask, followUp };
}

const titleOf = (s: SqliteStore, id: string): unknown =>
  (s.db.prepare('SELECT title FROM tasks WHERE id=?').get(id) as { title: unknown }).title;

describe('renameThread', () => {
  it('stores the title on the root task only and keeps its objective', async () => {
    const { s, rootTask, followUp } = await seed();
    const result = renameThread(s, rootTask, '  Renamed   thread  ');
    expect(result).toEqual({ threadId: rootTask, rootTaskId: rootTask, title: 'Renamed thread' });
    expect(titleOf(s, rootTask)).toBe('Renamed thread');
    expect(titleOf(s, followUp)).toBeNull();
    expect((s.db.prepare('SELECT objective FROM tasks WHERE id=?').get(rootTask) as { objective: string }).objective)
      .toBe('Original first message');
  });

  it('renames again, overwriting the previous title', async () => {
    const { s, rootTask } = await seed();
    renameThread(s, rootTask, 'First name');
    expect(renameThread(s, rootTask, 'Second name').title).toBe('Second name');
    expect(titleOf(s, rootTask)).toBe('Second name');
  });

  it('rejects blank titles and unknown threads', async () => {
    const { s, rootTask } = await seed();
    expect(() => renameThread(s, rootTask, '   ')).toThrow(/cannot be empty/);
    expect(() => renameThread(s, randomUUID(), 'Name')).toThrow(/no longer exists/);
    expect(titleOf(s, rootTask)).toBeNull();
  });
});
