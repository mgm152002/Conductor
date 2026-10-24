import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { SqliteStore } from '@main/db/store';
import { WorkspaceService } from '@main/domain/workspace-service';
import { AuditLog } from '@main/domain/audit-log';
import { DiskManagedStorage } from '@main/storage/managed-storage';
import { deleteProject } from '@main/domain/project-deletion';

let root: string | undefined;
let store: SqliteStore | undefined;
afterEach(() => { store?.close(); if (root) rmSync(root, { recursive: true, force: true }); });

async function seed() {
  root = mkdtempSync(join(tmpdir(), 'conductor-delete-'));
  writeFileSync(join(root, 'keep.txt'), 'project file');
  store = new SqliteStore(':memory:');
  await store.migrate();
  const s = store;
  const workspaces = new WorkspaceService(s);
  const doomed = workspaces.create({ name: 'Doomed', rootPath: root });
  const other = workspaces.create({ name: 'Other', rootPath: root });
  workspaces.select(doomed.id);
  const storage = new DiskManagedStorage(join(root, '.blobs'));
  const blob = storage.put('output');
  const now = new Date().toISOString();
  const addTask = (workspaceId: string, state: string): string => {
    const id = randomUUID();
    s.db.prepare(`INSERT INTO tasks (id, workspace_id, objective, state, created_at, updated_at) VALUES (?, ?, 'o', ?, ?, ?)`).run(id, workspaceId, state, now, now);
    return id;
  };
  const task = addTask(doomed.id, 'COMPLETED');
  const otherTask = addTask(other.id, 'COMPLETED');
  s.db.prepare(`INSERT INTO task_events (id, task_id, kind, payload, created_at) VALUES (?, ?, 'artifact', ?, ?)`).run(randomUUID(), task, JSON.stringify({ artifactId: blob.id }), now);
  s.db.prepare(`INSERT INTO approval_requests (id, task_id, subject_type, subject_id, summary, requirements, status, created_at, expires_at)
    VALUES (?, ?, 'agent', 'orchestrator', 's', '[]', 'approved', ?, ?)`).run(randomUUID(), task, now, now);
  s.db.prepare(`INSERT INTO agent_usage (session_id, task_id, workspace_id, adapter_id, created_at, updated_at) VALUES (?, ?, ?, 'codex', ?, ?)`).run('sess', task, doomed.id, now, now);
  s.db.prepare(`INSERT INTO memories (id, layer, content, veracity, confidence, method, scope_level, scope_ref_id, created_at)
    VALUES (?, 'project', 'm', 'observed_fact', 1, 'user_stated', 'project', ?, ?)`).run(randomUUID(), doomed.id, now);
  s.db.prepare(`INSERT INTO memories (id, layer, content, veracity, confidence, method, scope_level, scope_ref_id, created_at)
    VALUES (?, 'project', 'keep', 'observed_fact', 1, 'user_stated', 'project', ?, ?)`).run(randomUUID(), other.id, now);
  s.db.prepare(`INSERT INTO preferences (scope, workspace_id, key, value_json) VALUES ('workspace', ?, 'k', '1')`).run(doomed.id);
  s.db.prepare(`INSERT INTO connectors (id, kind, name, auth_state, health, config, created_at, updated_at) VALUES (?, 'files', 'Folder', 'authorized', 'healthy', ?, ?, ?)`)
    .run('conn-1', JSON.stringify({ workspaceId: doomed.id, rootPath: root }), now, now);
  return { s, doomed, other, storage, blob, task, otherTask, addTask };
}

const count = (s: SqliteStore, sql: string, ...args: unknown[]): number => (s.db.prepare(sql).get(...args) as { n: number }).n;

describe('deleteProject', () => {
  it('removes the project and everything stored for it, but not its files or other projects', async () => {
    const { s, doomed, other, storage, blob, otherTask } = await seed();
    const deletedConnectors: string[] = [];
    const result = await deleteProject({ store: s, storage, audit: new AuditLog(s), deleteConnector: async (id) => { deletedConnectors.push(id); s.db.prepare('DELETE FROM connectors WHERE id = ?').run(id); } }, doomed.id);
    expect(result).toMatchObject({ removedTasks: 1, removedThreads: 1, removedConnectors: 1, removedOutputs: 1, activeWorkspaceId: other.id });
    expect(deletedConnectors).toEqual(['conn-1']);
    expect(count(s, 'SELECT COUNT(*) AS n FROM workspaces WHERE id = ?', doomed.id)).toBe(0);
    expect(count(s, 'SELECT COUNT(*) AS n FROM tasks WHERE workspace_id = ?', doomed.id)).toBe(0);
    expect(count(s, 'SELECT COUNT(*) AS n FROM task_events')).toBe(0);
    expect(count(s, 'SELECT COUNT(*) AS n FROM approval_requests')).toBe(0);
    expect(count(s, 'SELECT COUNT(*) AS n FROM agent_usage')).toBe(0);
    expect(count(s, "SELECT COUNT(*) AS n FROM memories WHERE content = 'm'")).toBe(0);
    expect(count(s, "SELECT COUNT(*) AS n FROM memories WHERE content = 'keep'")).toBe(1);
    expect(count(s, 'SELECT COUNT(*) AS n FROM preferences WHERE workspace_id = ?', doomed.id)).toBe(0);
    expect(count(s, 'SELECT COUNT(*) AS n FROM tasks WHERE id = ?', otherTask)).toBe(1);
    expect(storage.has(blob.id)).toBe(false);
    expect(existsSync(join(root!, 'keep.txt'))).toBe(true);
    expect(count(s, "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'workspace.deleted'")).toBe(1);
  });

  it('refuses while a thread in the project is running', async () => {
    const { s, doomed, addTask, storage } = await seed();
    addTask(doomed.id, 'RUNNING');
    await expect(deleteProject({ store: s, storage, audit: new AuditLog(s) }, doomed.id)).rejects.toThrow('Stop the running thread in Doomed');
    expect(count(s, 'SELECT COUNT(*) AS n FROM workspaces WHERE id = ?', doomed.id)).toBe(1);
  });
});
