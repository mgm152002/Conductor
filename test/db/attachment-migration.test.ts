import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '@main/db/store';

let store: SqliteStore;

beforeEach(async () => {
  store = new SqliteStore(':memory:');
  await store.migrate();
});
afterEach(() => store.close());

describe('attachment owner cascades', () => {
  it('cascades task and chat links when their owners are deleted', () => {
    const now = '2026-10-25T00:00:00Z';
    store.db.prepare('INSERT INTO workspaces (id,name,root_path,created_at,updated_at) VALUES (?,?,?,?,?)')
      .run('workspace', 'Workspace', '/tmp/workspace', now, now);
    store.db.prepare("INSERT INTO tasks (id,workspace_id,objective,state,created_at,updated_at) VALUES (?,?,?,'COMPLETED',?,?)")
      .run('task', 'workspace', 'Task', now, now);
    store.db.prepare('INSERT INTO chat_threads (id,title,agent_id,created_at,updated_at) VALUES (?,?,?,?,?)')
      .run('thread', 'Chat', 'codex', now, now);
    store.db.prepare("INSERT INTO chat_messages (id,thread_id,role,content,status,created_at) VALUES (?,?,'user',?,'complete',?)")
      .run('message', 'thread', 'Chat message', now);
    for (const id of ['task-file', 'chat-file']) {
      store.db.prepare("INSERT INTO attachments (id,name,kind,mime_type,size_bytes,sha256,blob_id,created_at) VALUES (?,?,'text','text/plain',1,?,?,?)")
        .run(id, `${id}.txt`, id.repeat(8).slice(0, 64), `blob-${id}`, now);
    }
    store.db.prepare('INSERT INTO task_attachments (task_id,attachment_id,ordinal,created_at) VALUES (?,?,0,?)')
      .run('task', 'task-file', now);
    store.db.prepare('INSERT INTO chat_message_attachments (message_id,attachment_id,ordinal,created_at) VALUES (?,?,0,?)')
      .run('message', 'chat-file', now);

    store.db.prepare('DELETE FROM tasks WHERE id=?').run('task');
    store.db.prepare('DELETE FROM chat_threads WHERE id=?').run('thread');

    expect(store.db.prepare('SELECT count(*) AS n FROM task_attachments').get()).toEqual({ n: 0 });
    expect(store.db.prepare('SELECT count(*) AS n FROM chat_message_attachments').get()).toEqual({ n: 0 });
  });
});
