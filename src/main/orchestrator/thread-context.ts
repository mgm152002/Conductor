import type { Task } from '@shared/domain';
import type { Store } from '../db/types';
import { responseText } from '../adapters/objective-cli-adapter';

// Conversation-thread context for follow-up tasks. A follow-up is a new task
// linked to its predecessor; the agent either resumes the provider session
// (Codex records a thread id in its JSONL `thread.started` event) or, when that
// is not possible, receives the earlier turns as labelled reference data.

/** Max earlier turns included as reference, newest kept. */
export const MAX_THREAD_TURNS = 10;
/** Max characters of each earlier reply included as reference. */
export const MAX_TURN_REPLY_CHARS = 4_000;

export interface ThreadTurn {
  objective: string;
  reply: string;
  state: Task['state'];
}

/** Agents whose stdout is Codex JSONL (local or over SSH). */
export function isCodexProtocol(adapterId: string | null | undefined): boolean {
  return adapterId === 'codex' || (adapterId?.startsWith('remote:') ?? false);
}

/** The adapter that ran a task's last step, if any. */
export function lastAdapterFor(store: Store, taskId: string): string | undefined {
  const row = store.db.prepare(
    `SELECT assigned_adapter_id FROM task_steps WHERE task_id = ? AND assigned_adapter_id IS NOT NULL
     ORDER BY ordinal DESC, rowid DESC LIMIT 1`,
  ).get(taskId) as { assigned_adapter_id: string } | undefined;
  return row?.assigned_adapter_id;
}

function latestSessionStdout(store: Store, taskId: string): string[] {
  const session = store.db.prepare(
    `SELECT id FROM agent_sessions WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).get(taskId) as { id: string } | undefined;
  if (session === undefined) return [];
  const rows = store.db.prepare(
    `SELECT payload FROM task_events WHERE task_id = ? AND kind = 'stream'
       AND json_extract(payload, '$.kind') = 'stdout' AND json_extract(payload, '$.sessionId') = ?
     ORDER BY rowid`,
  ).all(taskId, session.id) as { payload: string }[];
  return rows.flatMap((row) => {
    const data = (JSON.parse(row.payload) as { data?: unknown }).data;
    return typeof data === 'string' ? [data] : [];
  });
}

function sessionStdout(store: Store, taskId: string, sessionId: string): string[] {
  const rows = store.db.prepare(
    `SELECT payload FROM task_events WHERE task_id = ? AND kind = 'stream'
       AND json_extract(payload, '$.kind') = 'stdout' AND json_extract(payload, '$.sessionId') = ?
     ORDER BY rowid`,
  ).all(taskId, sessionId) as { payload: string }[];
  return rows.flatMap((row) => {
    const data = (JSON.parse(row.payload) as { data?: unknown }).data;
    return typeof data === 'string' ? [data] : [];
  });
}

/**
 * One step's reply: the stdout of its successful session (or, failing that,
 * its latest session), parsed for Codex JSONL.
 */
export function stepReply(store: Store, taskId: string, stepId: string): string {
  const step = store.db.prepare('SELECT assigned_adapter_id FROM task_steps WHERE id = ?').get(stepId) as { assigned_adapter_id: string | null } | undefined;
  const success = store.db.prepare(`SELECT snapshot FROM checkpoints WHERE task_id = ? AND step_id = ?
    AND json_extract(snapshot, '$.status') = 'succeeded' ORDER BY rowid DESC LIMIT 1`).get(taskId, stepId) as { snapshot: string } | undefined;
  let sessionId = success !== undefined ? (JSON.parse(success.snapshot) as { sessionId?: unknown }).sessionId : undefined;
  if (typeof sessionId !== 'string') {
    const latest = store.db.prepare('SELECT id FROM agent_sessions WHERE task_id = ? AND step_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(taskId, stepId) as { id: string } | undefined;
    sessionId = latest?.id;
  }
  if (typeof sessionId !== 'string') return '';
  const raw = sessionStdout(store, taskId, sessionId).join('\n');
  return isCodexProtocol(step?.assigned_adapter_id) ? responseText(raw) : raw.trim();
}

function stepCount(store: Store, taskId: string): number {
  return (store.db.prepare('SELECT COUNT(*) AS n FROM task_steps WHERE task_id = ?').get(taskId) as { n: number }).n;
}

/**
 * The agent's final reply text for a task (empty when none was recorded). A
 * task with several steps (plan mode) replies with every step's answer, each
 * under its step description.
 */
export function replyFor(store: Store, taskId: string): string {
  if (stepCount(store, taskId) > 1) {
    const steps = store.db.prepare('SELECT id, description FROM task_steps WHERE task_id = ? ORDER BY ordinal').all(taskId) as { id: string; description: string }[];
    return steps.map((s) => ({ s, reply: stepReply(store, taskId, s.id) }))
      .filter(({ reply }) => reply !== '')
      .map(({ s, reply }) => `### ${s.description}\n${reply}`)
      .join('\n\n');
  }
  const lines = latestSessionStdout(store, taskId);
  const raw = lines.join('\n');
  return isCodexProtocol(lastAdapterFor(store, taskId)) ? responseText(raw) : raw.trim();
}

/**
 * The Codex provider thread id recorded by a task's latest session. A task
 * with several steps has several provider threads, so there is none to resume.
 */
export function codexSessionId(store: Store, taskId: string): string | undefined {
  if (stepCount(store, taskId) > 1) return undefined;
  for (const line of latestSessionStdout(store, taskId)) {
    if (!line.trimStart().startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as { type?: string; thread_id?: unknown };
      if (parsed.type === 'thread.started' && typeof parsed.thread_id === 'string' && /^[\w-]{8,128}$/.test(parsed.thread_id)) {
        return parsed.thread_id;
      }
    } catch { /* not JSON */ }
  }
  return undefined;
}

/** Earlier turns of the task's thread (oldest first), excluding the task itself. */
export function threadHistory(store: Store, task: Task): ThreadTurn[] {
  if (task.parentTaskId === undefined) return [];
  const threadId = task.threadId ?? task.parentTaskId;
  const rows = store.db.prepare(
    `SELECT id, objective, state FROM tasks
      WHERE (thread_id = ? OR id = ?) AND id != ? AND created_at <= ?
      ORDER BY created_at ASC, rowid ASC`,
  ).all(threadId, threadId, task.id, task.createdAt) as { id: string; objective: string; state: Task['state'] }[];
  return rows.slice(-MAX_THREAD_TURNS).map((row) => {
    const reply = replyFor(store, row.id);
    return {
      objective: row.objective,
      reply: reply.length > MAX_TURN_REPLY_CHARS ? `${reply.slice(0, MAX_TURN_REPLY_CHARS)}… (truncated)` : reply,
      state: row.state,
    };
  });
}

/**
 * The provider session a follow-up should resume, when its step is pinned to
 * the same agent that ran the previous turn and that agent recorded a session.
 */
export function resumeTargetFor(store: Store, task: Task, requiredCapability: string): { adapterId: string; sessionId: string } | undefined {
  if (task.parentTaskId === undefined) return undefined;
  const adapterId = lastAdapterFor(store, task.parentTaskId);
  if (adapterId === undefined || requiredCapability !== `objective.fulfill.${adapterId}` || !isCodexProtocol(adapterId)) return undefined;
  const sessionId = codexSessionId(store, task.parentTaskId);
  return sessionId === undefined ? undefined : { adapterId, sessionId };
}
