import type { Store } from '../db/types';

// Renaming a Work thread stores the user's title on the thread's root task
// (the task whose id is the thread id). The root task's objective — the first
// message of the conversation — is never changed.

export interface ThreadRenameResult {
  threadId: string;
  /** The root task the title was stored on. */
  rootTaskId: string;
  title: string;
}

export function renameThread(store: Store, threadId: string, title: string): ThreadRenameResult {
  const clean = title.trim().replace(/\s+/g, ' ');
  if (clean === '') throw new Error('Thread title cannot be empty');
  if (clean.length > 120) throw new Error('Thread title is too long');
  const rows = store.db.prepare(`SELECT id FROM tasks
    WHERE COALESCE(thread_id, id) = ? ORDER BY created_at ASC, rowid ASC`).all(threadId) as { id: string }[];
  if (rows.length === 0) throw new Error('That thread no longer exists.');
  const rootTaskId = rows.find((row) => row.id === threadId)?.id ?? rows[0]!.id;
  store.db.prepare('UPDATE tasks SET title=? WHERE id=?').run(clean, rootTaskId);
  return { threadId, rootTaskId, title: clean };
}
