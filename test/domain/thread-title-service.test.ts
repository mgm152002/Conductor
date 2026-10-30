import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '@main/db/store';
import { WorkspaceService } from '@main/domain/workspace-service';
import { ThreadTitleService, cleanGeneratedTitle } from '@main/domain/thread-title-service';
import type { Task } from '@shared/domain';

let store: SqliteStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

async function seed(generate: (objective: string) => Promise<string | undefined>) {
  store = new SqliteStore(':memory:');
  await store.migrate();
  const s = store;
  const workspaces = new WorkspaceService(s);
  const project = workspaces.create({ name: 'Project', rootPath: mkdtempSync(join(tmpdir(), 'conductor-title-')) });
  const now = new Date().toISOString();
  const insert = (objective: string, parent?: string): Task => {
    const id = randomUUID();
    s.db.prepare(`INSERT INTO tasks (id, workspace_id, objective, state, thread_id, parent_task_id, created_at, updated_at)
                  VALUES (?, ?, ?, 'RUNNING', ?, ?, ?, ?)`)
      .run(id, project.id, objective, parent ?? id, parent ?? null, now, now);
    return get(id);
  };
  const get = (id: string): Task => {
    const row = s.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown>;
    return {
      id: row['id'], workspaceId: row['workspace_id'], objective: row['objective'], state: row['state'],
      acceptanceCriteria: [], contextRefs: [], createdAt: row['created_at'], updatedAt: row['updated_at'],
      ...((row['thread_id'] as string) !== row['id'] ? { threadId: row['thread_id'] as string } : {}),
      ...(row['parent_task_id'] ? { parentTaskId: row['parent_task_id'] as string } : {}),
      ...(row['title'] ? { title: row['title'] as string } : {}),
    } as Task;
  };
  const updated: Task[] = [];
  const service = new ThreadTitleService({
    store: s, getTask: get, onTaskUpdated: (task) => { updated.push(task); }, generate,
  });
  return { s, project, service, insert, get, updated };
}

const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 10); });

describe('cleanGeneratedTitle', () => {
  it('strips model formatting, prefixes and quotes, and caps the length', () => {
    expect(cleanGeneratedTitle('Title: "Fix login redirect loop."')).toBe('Fix login redirect loop');
    expect(cleanGeneratedTitle('**Add dark mode toggle**\n(extra chatter)')).toBe('Add dark mode toggle');
    expect(cleanGeneratedTitle('```\nRefactor the payments module\n```')).toBe('Refactor the payments module');
    expect(cleanGeneratedTitle('x')).toBeUndefined();
    expect(cleanGeneratedTitle('   ')).toBeUndefined();
    const long = cleanGeneratedTitle('word '.repeat(30).trim());
    expect(long!.length).toBeLessThanOrEqual(60);
    expect(long!.endsWith(' ')).toBe(false);
  });
});

describe('ThreadTitleService', () => {
  it('replaces the first-message placeholder with the model title and emits the update', async () => {
    const { service, insert, get, updated } = await seed(async () => 'Title: "Fix login redirect loop"');
    const task = insert('please fix the login redirect loop, it bounces back to /login');
    service.schedule(task);
    await tick();
    expect(get(task.id).title).toBe('Fix login redirect loop');
    expect(updated.map((t) => t.title)).toContain('Fix login redirect loop');
  });

  it('never overwrites a title the user set while generation was in flight', async () => {
    let release: (value: string) => void = () => undefined;
    const { s, service, insert, get } = await seed(() => new Promise<string>((resolve) => { release = resolve; }));
    const task = insert('do the thing');
    const pending = service.ensure(task);
    await tick();
    s.db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('My own name', task.id);
    release('Model name');
    await pending;
    expect(get(task.id).title).toBe('My own name');
  });

  it('returns an existing title without calling the model, and skips follow-ups', async () => {
    let calls = 0;
    const { s, service, insert } = await seed(async () => { calls += 1; return 'Generated'; });
    const root = insert('root objective');
    s.db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('Already named', root.id);
    await expect(service.ensure({ ...root, title: 'Already named' })).resolves.toBe('Already named');
    const followUp = insert('follow up message', root.id);
    await expect(service.ensure(followUp)).resolves.toBeUndefined();
    expect(calls).toBe(0);
  });

  it('keeps the placeholder when generation yields nothing usable', async () => {
    const { service, insert, get } = await seed(async () => 'no');
    const task = insert('some objective here');
    await expect(service.ensure(task)).resolves.toBeUndefined();
    expect(get(task.id).title).toBeUndefined();
  });

  it('backfills recent untitled roots only', async () => {
    const { service, insert, get } = await seed(async () => 'Backfilled Title');
    const a = insert('first untitled');
    const b = insert('second untitled');
    insert('follow up', a.id);
    service.scheduleRecent(10);
    await tick(); await tick();
    expect(get(a.id).title).toBe('Backfilled Title');
    expect(get(b.id).title).toBe('Backfilled Title');
  });
});
