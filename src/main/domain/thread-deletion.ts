import type { AttachmentService } from '../attachments/attachment-service';
import { rmdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ThreadDeletionResult } from '@shared/domain';
import type { Store } from '../db/types';
import type { ManagedStorage } from '../storage/managed-storage';
import type { AuditLog } from './audit-log';
import { Mem0Error } from './mem0-client';

// Deleting a conversation thread removes every message (task) in it and what
// Conductor stored for those tasks: steps, events, checkpoints, sessions,
// approvals, outcomes, suggestions, plans, usage, artifacts, and task-scoped
// context and memory. Only managed attachment copies in the project folder are removed.

export class ThreadDeletionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThreadDeletionError';
  }
}

export type { ThreadDeletionResult };

export interface ThreadDeletionDeps {
  store: Store;
  attachments?: AttachmentService;
  storage?: ManagedStorage | undefined;
  audit: AuditLog;
  flushMemories?: () => Promise<void>;
}

const ACTIVE = ['CREATED', 'CONTEXT_LOADING', 'PLANNING', 'WAITING_FOR_APPROVAL', 'RUNNING', 'VERIFYING'];

export async function deleteThread(deps: ThreadDeletionDeps, threadId: string): Promise<ThreadDeletionResult> {
  const { store } = deps;
  const rows = store.db.prepare(`SELECT id, workspace_id, objective, state FROM tasks
    WHERE COALESCE(thread_id, id) = ? ORDER BY created_at ASC, rowid ASC`).all(threadId) as { id: string; workspace_id: string; objective: string; state: string }[];
  if (rows.length === 0) throw new ThreadDeletionError('That thread no longer exists.');
  const running = rows.filter((row) => ACTIVE.includes(row.state)).length;
  if (running > 0) {
    const title = rows[0]!.objective.trim().slice(0, 60);
    throw new ThreadDeletionError(`Stop "${title}" before deleting it.`);
  }

  const taskIds = rows.map((row) => row.id);
  const workspaceId = rows[0]!.workspace_id;
  // Saved outputs live in managed storage, referenced from task events.
  const artifactIds = new Set<string>();
  for (const taskId of taskIds) {
    const artifacts = store.db.prepare(`SELECT json_extract(payload, '$.artifactId') AS id FROM task_events
      WHERE task_id = ? AND json_extract(payload, '$.artifactId') IS NOT NULL`).all(taskId) as { id: unknown }[];
    for (const artifact of artifacts) if (typeof artifact.id === 'string') artifactIds.add(artifact.id);
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
    // Task-scoped knowledge.
    for (const table of ['context_items', 'memories']) {
      db.exec(`DELETE FROM ${table} WHERE scope_level = 'task' AND scope_ref_id IN (SELECT id FROM deleting_tasks)`);
    }
    // Cascades to steps, events, checkpoints, sessions, plans, usage and
    // workflow links.
    db.exec('DELETE FROM tasks WHERE id IN (SELECT id FROM deleting_tasks)');
    db.exec('DELETE FROM deleting_tasks');
  });

  let removedOutputs = 0;
  for (const id of artifactIds) {
    try { deps.storage?.delete(id); removedOutputs += 1; } catch { /* already gone */ }
  }
  deps.audit.append({
    actor: 'user', action: 'thread.deleted', target: threadId,
    redactedPayload: { workspaceId, title: rows[0]!.objective.trim().slice(0, 120), tasks: taskIds.length, outputs: removedOutputs },
  });
  let memoryCleanupPending = false;
  try { await deps.flushMemories?.(); }
  catch (error) { if (error instanceof Mem0Error) memoryCleanupPending = true; else throw error; }
  return {
    threadId, workspaceId, removedTasks: taskIds.length, removedOutputs,
    ...(memoryCleanupPending ? { memoryCleanupPending: true } : {}),
  };
}
