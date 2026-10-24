import type { AttachmentService } from '../attachments/attachment-service';
import { rmdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectDeletionResult } from '@shared/domain';
import type { Store } from '../db/types';
import type { ManagedStorage } from '../storage/managed-storage';
import type { AuditLog } from './audit-log';
import { Mem0Error } from './mem0-client';

// Deleting a project (workspace) removes everything Conductor stored for it:
// threads and their steps, events, checkpoints, sessions, approvals, outcomes,
// plans, usage and saved outputs; project-scoped memory, context and skills;
// project preferences; and folder connectors that index the project (with
// their ingested items). Only managed attachment copies in the project folder are removed.

export class ProjectDeletionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectDeletionError';
  }
}

export type { ProjectDeletionResult };

export interface ProjectDeletionDeps {
  store: Store;
  attachments?: AttachmentService;
  storage?: ManagedStorage | undefined;
  audit: AuditLog;
  /** Deletes a connector with its watcher, ingested items and memories. */
  deleteConnector?: (id: string) => Promise<unknown>;
  flushMemories?: () => Promise<void>;
}

const ACTIVE = ['CREATED', 'CONTEXT_LOADING', 'PLANNING', 'WAITING_FOR_APPROVAL', 'RUNNING', 'VERIFYING'];

export async function deleteProject(deps: ProjectDeletionDeps, workspaceId: string): Promise<ProjectDeletionResult> {
  const { store } = deps;
  const workspace = store.db.prepare('SELECT id, name FROM workspaces WHERE id = ?').get(workspaceId) as { id: string; name: string } | undefined;
  if (workspace === undefined) throw new ProjectDeletionError('That project no longer exists.');
  const running = store.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE workspace_id = ? AND state IN (${ACTIVE.map(() => '?').join(', ')})`)
    .get(workspaceId, ...ACTIVE) as { n: number };
  if (running.n > 0) throw new ProjectDeletionError(`Stop the ${running.n === 1 ? 'running thread' : `${running.n} running threads`} in ${workspace.name} before deleting it.`);

  // Folder connectors that index this project.
  const connectors = (store.db.prepare(`SELECT id FROM connectors WHERE json_extract(config, '$.workspaceId') = ?`).all(workspaceId) as { id: string }[]).map((r) => r.id);
  for (const id of connectors) {
    if (deps.deleteConnector !== undefined) await deps.deleteConnector(id);
  }

  const taskIds = (store.db.prepare('SELECT id FROM tasks WHERE workspace_id = ?').all(workspaceId) as { id: string }[]).map((r) => r.id);
  const threads = store.db.prepare('SELECT COUNT(DISTINCT COALESCE(thread_id, id)) AS n FROM tasks WHERE workspace_id = ?').get(workspaceId) as { n: number };
  // Saved outputs live in managed storage, referenced from task events.
  const artifactIds = new Set<string>();
  for (const taskId of taskIds) {
    const rows = store.db.prepare(`SELECT json_extract(payload, '$.artifactId') AS id FROM task_events
      WHERE task_id = ? AND json_extract(payload, '$.artifactId') IS NOT NULL`).all(taskId) as { id: unknown }[];
    for (const row of rows) if (typeof row.id === 'string') artifactIds.add(row.id);
  }

  // Read and remove copy paths before owner cascades erase the links.
  const root = store.db.prepare('SELECT root_path FROM workspaces WHERE id=?').get(workspaceId) as { root_path: string } | undefined;
  for (const taskId of taskIds) {
    deps.attachments?.cleanup({ taskId });
    if (deps.attachments && root) {
      try { rmdirSync(join(root.root_path, '.conductor', 'attachments', taskId)); }
      catch { /* absent or contains files not managed by Conductor */ }
    }
  }

  store.transaction((tx) => {
    const db = tx.db;
    db.exec('CREATE TEMP TABLE IF NOT EXISTS deleting_tasks (id TEXT PRIMARY KEY)');
    db.exec('DELETE FROM deleting_tasks');
    const insert = db.prepare('INSERT INTO deleting_tasks (id) VALUES (?)');
    for (const id of taskIds) insert.run(id);
    // Tables keyed by task id without a cascading foreign key.
    db.exec('DELETE FROM approval_requests WHERE task_id IN (SELECT id FROM deleting_tasks)');
    db.exec('DELETE FROM task_outcomes WHERE task_id IN (SELECT id FROM deleting_tasks)');
    db.exec('DELETE FROM suggestions WHERE source_id IN (SELECT id FROM deleting_tasks)');
    // Project- and task-scoped knowledge.
    for (const table of ['context_items', 'memories']) {
      db.prepare(`DELETE FROM ${table} WHERE (scope_level = 'project' AND scope_ref_id = ?)
        OR (scope_level = 'task' AND scope_ref_id IN (SELECT id FROM deleting_tasks))`).run(workspaceId);
    }
    db.prepare(`DELETE FROM skills WHERE scope = 'project' AND scope_ref = ?`).run(workspaceId);
    db.prepare(`DELETE FROM preferences WHERE scope = 'workspace' AND workspace_id = ?`).run(workspaceId);
    // Cascades to tasks → steps, events, checkpoints, sessions, plans, usage,
    // workflow links; clears the active-workspace pointer.
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId);
    db.exec('DELETE FROM deleting_tasks');
    // Keep a project selected when others remain.
    const pointer = db.prepare('SELECT workspace_id FROM active_workspace WHERE id = 1').get() as { workspace_id: string | null } | undefined;
    if (pointer?.workspace_id == null) {
      const next = db.prepare('SELECT id FROM workspaces ORDER BY created_at ASC, rowid ASC LIMIT 1').get() as { id: string } | undefined;
      if (next !== undefined) db.prepare('UPDATE active_workspace SET workspace_id = ? WHERE id = 1').run(next.id);
    }
  });

  let removedOutputs = 0;
  for (const id of artifactIds) {
    try { deps.storage?.delete(id); removedOutputs += 1; } catch { /* already gone */ }
  }
  const active = store.db.prepare('SELECT workspace_id FROM active_workspace WHERE id = 1').get() as { workspace_id: string | null } | undefined;
  deps.audit.append({
    actor: 'user', action: 'workspace.deleted', target: workspaceId,
    redactedPayload: { name: workspace.name, tasks: taskIds.length, connectors: connectors.length, outputs: removedOutputs },
  });
  let memoryCleanupPending = false;
  try { await deps.flushMemories?.(); }
  catch (error) { if (error instanceof Mem0Error) memoryCleanupPending = true; else throw error; }
  return {
    workspaceId, removedThreads: threads.n, removedTasks: taskIds.length, removedConnectors: connectors.length,
    removedOutputs, activeWorkspaceId: active?.workspace_id ?? null,
    ...(memoryCleanupPending ? { memoryCleanupPending: true } : {}),
  };
}
