import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { SqliteStore } from '@main/db/store';
import { WorkspaceService } from '@main/domain/workspace-service';
import { AuditLog } from '@main/domain/audit-log';
import { DiskManagedStorage } from '@main/storage/managed-storage';
import { deleteThread } from '@main/domain/thread-deletion';
import { AttachmentService } from '@main/attachments/attachment-service';

let root: string | undefined;
let store: SqliteStore | undefined;
afterEach(() => { store?.close(); if (root) rmSync(root, { recursive: true, force: true }); });

async function seed() {
  root = mkdtempSync(join(tmpdir(), 'conductor-delete-thread-'));
  writeFileSync(join(root, 'keep.txt'), 'project file');
  store = new SqliteStore(':memory:');
  await store.migrate();
  const s = store;
  const workspaces = new WorkspaceService(s);
  const project = workspaces.create({ name: 'Project', rootPath: root });
  const otherProject = workspaces.create({ name: 'Other', rootPath: root });
  const storage = new DiskManagedStorage(join(root, '.blobs'));
  const blob = storage.put('thread output');
  const otherBlob = storage.put('other output');
  const now = new Date().toISOString();
  const addTask = (workspaceId: string, threadId: string, state = 'COMPLETED', objective = 'o'): string => {
    const id = randomUUID();
    s.db.prepare(`INSERT INTO tasks (id, workspace_id, objective, state, thread_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, workspaceId, objective, state, threadId, now, now);
    return id;
  };
  const rootTask = addTask(project.id, 'pending', 'COMPLETED', 'Delete this thread');
  s.db.prepare('UPDATE tasks SET thread_id = ? WHERE id = ?').run(rootTask, rootTask);
  const followUp = addTask(project.id, rootTask);
  const otherThreadTask = addTask(project.id, 'pending');
  s.db.prepare('UPDATE tasks SET thread_id = ? WHERE id = ?').run(otherThreadTask, otherThreadTask);
  const otherProjectTask = addTask(otherProject.id, 'pending');
  s.db.prepare('UPDATE tasks SET thread_id = ? WHERE id = ?').run(otherProjectTask, otherProjectTask);

  for (const [taskId, artifactId] of [[rootTask, blob.id], [followUp, blob.id], [otherThreadTask, otherBlob.id]] as const) {
    s.db.prepare(`INSERT INTO task_events (id, task_id, kind, payload, created_at) VALUES (?, ?, 'artifact', ?, ?)`)
      .run(randomUUID(), taskId, JSON.stringify({ artifactId }), now);
  }
  for (const taskId of [rootTask, followUp, otherThreadTask]) {
    s.db.prepare(`INSERT INTO approval_requests (id, task_id, subject_type, subject_id, summary, requirements, status, created_at, expires_at)
      VALUES (?, ?, 'agent', 'orchestrator', 's', '[]', 'approved', ?, ?)`).run(randomUUID(), taskId, now, now);
    s.db.prepare(`INSERT INTO task_outcomes (id, task_id, comparability_key, result, duration_ms, recorded_at)
      VALUES (?, ?, 'k', 'success', 1, ?)`).run(randomUUID(), taskId, now);
    s.db.prepare(`INSERT INTO suggestions (id, trigger_kind, source_id, trigger, action, explanation, status, created_at)
      VALUES (?, 'task_interrupted', ?, '{}', '{}', 'e', 'suggested', ?)`).run(randomUUID(), taskId, now);
    s.db.prepare(`INSERT INTO context_items (id, scope_level, scope_ref_id, content, veracity, confidence, created_at, updated_at)
      VALUES (?, 'task', ?, 'c', 'observed_fact', 1, ?, ?)`).run(randomUUID(), taskId, now, now);
    s.db.prepare(`INSERT INTO memories (id, layer, content, veracity, confidence, method, scope_level, scope_ref_id, created_at)
      VALUES (?, 'task', 'm', 'observed_fact', 1, 'user_stated', 'task', ?, ?)`).run(randomUUID(), taskId, now);
    s.db.prepare(`INSERT INTO agent_usage (session_id, task_id, workspace_id, adapter_id, created_at, updated_at)
      VALUES (?, ?, ?, 'codex', ?, ?)`).run(randomUUID(), taskId, project.id, now, now);
  }
  return { s, project, otherProject, storage, blob, otherBlob, rootTask, followUp, otherThreadTask, otherProjectTask, addTask };
}

const count = (s: SqliteStore, sql: string, ...args: unknown[]): number => (s.db.prepare(sql).get(...args) as { n: number }).n;

describe('deleteThread', () => {
  it('removes task attachment links, materialized copies, and unreferenced blobs', async () => {
    const { s, storage, rootTask } = await seed();
    const attachments = new AttachmentService(s, storage);
    const source = join(root!, 'delete-me.md');
    writeFileSync(source, '# Temporary attachment');
    const attachment = (await attachments.ingest([source])).attachments[0]!;
    attachments.linkTask(rootTask, [attachment.id]);
    const [materialized] = await attachments.materialize(
      [attachment.id], join(root!, '.conductor', 'attachments', rootTask), { taskId: rootTask },
    );
    const blob = s.db.prepare('SELECT blob_id FROM attachments WHERE id=?').get(attachment.id) as { blob_id: string };

    await deleteThread({ store: s, storage, attachments, audit: new AuditLog(s) }, rootTask);

    expect(existsSync(materialized!.path)).toBe(false);
    expect(storage.has(blob.blob_id)).toBe(false);
    expect(count(s, 'SELECT COUNT(*) AS n FROM task_attachments WHERE attachment_id=?', attachment.id)).toBe(0);
    expect(count(s, 'SELECT COUNT(*) AS n FROM attachments WHERE id=?', attachment.id)).toBe(0);
  });

  it('removes every message in the thread and what Conductor stored for it', async () => {
    const { s, project, storage, blob, otherBlob, rootTask, followUp, otherThreadTask, otherProjectTask } = await seed();
    const result = await deleteThread({ store: s, storage, audit: new AuditLog(s) }, rootTask);

    expect(result).toMatchObject({ threadId: rootTask, workspaceId: project.id, removedTasks: 2, removedOutputs: 1 });
    expect(count(s, 'SELECT COUNT(*) AS n FROM tasks WHERE id IN (?, ?)', rootTask, followUp)).toBe(0);
    expect(count(s, 'SELECT COUNT(*) AS n FROM tasks WHERE id IN (?, ?)', otherThreadTask, otherProjectTask)).toBe(2);
    expect(count(s, 'SELECT COUNT(*) AS n FROM task_events WHERE task_id IN (?, ?)', rootTask, followUp)).toBe(0);
    expect(count(s, 'SELECT COUNT(*) AS n FROM approval_requests')).toBe(1);
    expect(count(s, 'SELECT COUNT(*) AS n FROM task_outcomes')).toBe(1);
    expect(count(s, 'SELECT COUNT(*) AS n FROM suggestions')).toBe(1);
    expect(count(s, 'SELECT COUNT(*) AS n FROM context_items')).toBe(1);
    expect(count(s, 'SELECT COUNT(*) AS n FROM memories')).toBe(1);
    expect(count(s, 'SELECT COUNT(*) AS n FROM agent_usage')).toBe(1);
    expect(storage.has(blob.id)).toBe(false);
    expect(storage.has(otherBlob.id)).toBe(true);
    expect(existsSync(join(root!, 'keep.txt'))).toBe(true);
    expect(count(s, "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'thread.deleted'")).toBe(1);
  });

  it('refuses while a message in the thread is active', async () => {
    const { s, project, storage, rootTask, addTask } = await seed();
    const running = addTask(project.id, rootTask, 'RUNNING');
    await expect(deleteThread({ store: s, storage, audit: new AuditLog(s) }, rootTask)).rejects.toThrow('Stop "Delete this thread" before deleting it');
    expect(count(s, 'SELECT COUNT(*) AS n FROM tasks WHERE thread_id = ?', rootTask)).toBe(3);
    expect(count(s, 'SELECT COUNT(*) AS n FROM tasks WHERE id = ?', running)).toBe(1);
  });

  it('treats a legacy task without a thread id as its own thread', async () => {
    const { s, project, storage, otherThreadTask } = await seed();
    const now = new Date().toISOString();
    const legacy = randomUUID();
    s.db.prepare(`INSERT INTO tasks (id, workspace_id, objective, state, created_at, updated_at) VALUES (?, ?, 'legacy', 'COMPLETED', ?, ?)`)
      .run(legacy, project.id, now, now);
    const result = await deleteThread({ store: s, storage, audit: new AuditLog(s) }, legacy);
    expect(result.removedTasks).toBe(1);
    expect(count(s, 'SELECT COUNT(*) AS n FROM tasks WHERE id = ?', legacy)).toBe(0);
    expect(count(s, 'SELECT COUNT(*) AS n FROM tasks WHERE id = ?', otherThreadTask)).toBe(1);
  });
});
