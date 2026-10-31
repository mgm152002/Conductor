import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '@main/db/store';
import { WorkspaceService } from '@main/domain/workspace-service';
import { AgentTitleGenerator, ThreadTitleService, cleanGeneratedTitle } from '@main/domain/thread-title-service';
import type { Registry } from '@main/registry/registry';
import { FakeAdapter, type FakeAdapterScript } from '../fakes/fake-adapter';
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

describe('AgentTitleGenerator', () => {
  const capability = { id: 'objective.fulfill', title: 'Chat', inputSchema: {}, outputSchema: {}, streaming: true, cancellable: true, resumable: false, requiredPermissions: [] };
  const fake = (id: string, script: FakeAdapterScript): FakeAdapter =>
    new FakeAdapter({ script, record: { id, class: 'local_cli_agent', available: true, capabilities: [capability] } });
  const registryFor = (adapters: FakeAdapter[]): Registry => ({
    listAdapters: () => adapters.map((a) => a.record),
    resolve: (id: string) => adapters.find((a) => a.record.id === id)!,
  }) as unknown as Registry;
  const sandbox = (): string => mkdtempSync(join(tmpdir(), 'conductor-title-gen-'));

  it('pins the Settings model instead of leaving the CLI on its own default', async () => {
    const adapter = fake('opencode', { events: [{ kind: 'stdout', data: 'Fix the login loop' }] });
    const generator = new AgentTitleGenerator(registryFor([adapter]), sandbox(), undefined, 5_000, {
      settingsRunChoice: () => ({ model: 'opencode/deepseek-v4.1-flash-free' }),
    });
    await expect(generator.generate('fix the login loop please')).resolves.toBe('Fix the login loop');
    const input = adapter.calls.started[0] as { models?: Record<string, string> };
    expect(input.models).toEqual({ opencode: 'opencode/deepseek-v4.1-flash-free' });
  });

  it('returns raw agent text for caller-built prompts such as PR descriptions', async () => {
    const adapter = fake('opencode', { events: [{ kind: 'stdout', data: '## Summary\n\nDid the thing.' }] });
    const generator = new AgentTitleGenerator(registryFor([adapter]), sandbox(), undefined, 5_000);
    await expect(generator.generateText('Write the PR description for this diff', 'Describe a change'))
      .resolves.toBe('## Summary\n\nDid the thing.');
    const input = adapter.calls.started[0] as { objective?: string; description?: string };
    expect(input.objective).toBe('Write the PR description for this diff');
    expect(input.description).toBe('Describe a change');
  });

  it('retries the same agent on its Settings fallback model when the primary fails', async () => {
    const adapter = fake('opencode', { events: [{ kind: 'stdout', data: 'Fix the login loop' }] });
    const originalAwait = adapter.await.bind(adapter);
    let awaits = 0;
    adapter.await = async (handle) => {
      awaits += 1;
      return awaits === 1 ? { status: 'failed', error: 'Free usage limit reached' } : originalAwait(handle);
    };
    const generator = new AgentTitleGenerator(registryFor([adapter]), sandbox(), undefined, 5_000, {
      fallbackModel: (agentId) => agentId === 'opencode' ? 'opencode/beam-free' : undefined,
    });
    await expect(generator.generate('fix the login loop please')).resolves.toBe('Fix the login loop');
    expect(adapter.calls.started).toHaveLength(2);
    const retry = adapter.calls.started[1] as { models?: Record<string, string> };
    expect(retry.models).toEqual({ opencode: 'opencode/beam-free' });
  });

  it('falls back to the next agent when the first fails, and reports it', async () => {
    const broken = fake('opencode', { crashAt: 'start', crashMessage: 'default model unavailable' });
    const working = fake('codex', { events: [{ kind: 'stdout', data: '{"type":"item.completed","item":{"type":"agent_message","text":"Plan the weekend trip"}}' }] });
    const errors: string[] = [];
    const generator = new AgentTitleGenerator(registryFor([broken, working]), sandbox(), undefined, 5_000, {
      onError: (message) => { errors.push(message); },
    });
    await expect(generator.generate('plan a weekend trip')).resolves.toBe('Plan the weekend trip');
    expect(errors[0]).toContain('opencode');
    expect(errors[0]).toContain('default model unavailable');
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

  it('fills the title when scheduled again after an early generation failure', async () => {
    // Creation-time generation can lose to a quota failure while the work
    // agent runs; a later schedule (e.g. when the task settles) must retry.
    let calls = 0;
    const { service, insert, get } = await seed(async () => { calls += 1; return calls === 1 ? undefined : 'Recovered Title'; });
    const task = insert('fix the login loop');
    service.schedule(task);
    await tick(); await tick();
    expect(get(task.id).title).toBeUndefined();
    service.schedule(task);
    await tick(); await tick();
    expect(get(task.id).title).toBe('Recovered Title');
    expect(calls).toBe(2);
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
