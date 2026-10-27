import type { Task, TaskEvent } from '@shared/domain';
import type { TaskDetails } from '@shared/task-view';
import type { AttachmentRef } from '@shared/attachments';

// Turns a task's persisted events into a chat timeline in the T3 Code shape:
// the user's message, collapsible groups of agent work (commands, file edits,
// reasoning, lifecycle), the agent's prose replies, and errors.
//
// Agent stdout arrives one line per stream event. Codex emits JSONL
// (`codex exec --json`): agent_message items become replies and
// command/file/reasoning items become work entries. Any other line (e.g.
// Claude Code's text output) is treated as reply prose.

export type WorkTone = 'neutral' | 'success' | 'error' | 'running';

export interface WorkEntry {
  id: string;
  icon: 'terminal' | 'file' | 'thinking' | 'tool' | 'search' | 'read' | 'plan' | 'state' | 'artifact' | 'approval';
  label: string;
  detail?: string;
  tone: WorkTone;
  at: string;
  /** Stable id used to merge a start event with its later completion. */
  key?: string;
  /** Agent or step that produced this activity. */
  source?: string;
  /** Diagnostic notices (config warnings) never summarize a work group. */
  notice?: boolean;
}

export type TimelineItem =
  | { kind: 'user'; id: string; text: string; criteria: string[]; attachments: readonly AttachmentRef[]; at: string }
  | { kind: 'work'; id: string; entries: WorkEntry[] }
  | { kind: 'assistant'; id: string; text: string; at: string }
  | { kind: 'notice'; id: string; text: string; at: string }
  | { kind: 'error'; id: string; text: string; at: string; stale?: boolean }
  | { kind: 'diagnostics'; id: string; text: string; at: string };

type Json = Record<string, unknown>;

function obj(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** A log event that announces Conductor switching this step to another agent. */
export function isAgentFallbackEvent(event: TaskEvent): boolean {
  return event.kind === 'log' && obj(event.payload)?.['agentFallback'] === true;
}

const STATE_LABELS: Record<string, string> = {
  CONTEXT_LOADING: 'Loading context',
  PLANNING: 'Planning',
  WAITING_FOR_APPROVAL: 'Waiting for approval',
  RUNNING: 'Running',
  VERIFYING: 'Verifying results',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  BLOCKED: 'Blocked',
  CANCELLED: 'Stopped',
  RECOVERABLE_INTERRUPTION: 'Interrupted',
};

/** A compact one-line label for reasoning and other free-form activity. */
function firstLine(text: string, limit = 120): string {
  const line = text.trim().split('\n').find((entry) => entry.trim() !== '') ?? '';
  const clean = line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').replace(/\*\*/g, '').trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

/** Map adapter activity kinds to the lucide-style icon shown in the work log. */
function iconForLogKind(kind: string | undefined): WorkEntry['icon'] {
  switch (kind) {
    case 'execute': case 'command': case 'run': case 'bash': case 'shell': return 'terminal';
    case 'edit': case 'write': case 'file_change': case 'delete': case 'move': return 'file';
    case 'search': case 'grep': case 'glob': case 'find': case 'fetch': return 'search';
    case 'read': case 'open': return 'read';
    case 'reasoning': case 'thought': case 'thinking': case 'think': return 'thinking';
    case 'plan': case 'todo': return 'plan';
    case 'approval': return 'approval';
    default: return 'tool';
  }
}

function toneForStatus(status: string | undefined): WorkTone {
  if (status === 'failed' || status === 'error') return 'error';
  if (status === 'running' || status === 'in_progress' || status === 'pending') return 'running';
  if (status === 'completed' || status === 'success' || status === 'succeeded') return 'success';
  return 'neutral';
}

/** Builds timeline items from task details. Pure; safe to unit test. */
export function buildTimeline(task: Task, details: TaskDetails | null): TimelineItem[] {
  const items: TimelineItem[] = [{
    kind: 'user',
    id: `user:${task.id}`,
    text: task.objective,
    criteria: task.acceptanceCriteria,
    attachments: details?.attachments ?? [],
    at: task.createdAt,
  }];
  if (details === null) return items;

  let work: WorkEntry[] = [];
  let workIndex = 0;
  let prose: { lines: string[]; at: string; id: string } | null = null;
  const diagnostics = new Map<string, { lines: string[]; at: string }>();
  // Codex reports an item twice (started, completed); later reports update the same entry.
  const byItemId = new Map<string, WorkEntry>();
  // ACP/Claude activities carry a tool-call key, so start/completion stay one row.
  const byKey = new Map<string, WorkEntry>();

  const flushWork = (): void => {
    if (work.length === 0) return;
    items.push({ kind: 'work', id: `work:${workIndex++}:${work[0]!.id}`, entries: work });
    work = [];
  };
  const flushProse = (): void => {
    if (prose === null) return;
    const text = prose.lines.join('\n').trim();
    if (text !== '') items.push({ kind: 'assistant', id: prose.id, text, at: prose.at });
    prose = null;
  };
  const addWork = (entry: WorkEntry): void => { flushProse(); work.push(entry); };
  const addNotice = (id: string, text: string, at: string): void => {
    flushProse();
    flushWork();
    items.push({ kind: 'notice', id, text, at });
  };
  const addReply = (id: string, text: string, at: string): void => {
    flushProse();
    flushWork();
    if (text.trim() !== '') items.push({ kind: 'assistant', id, text: text.trim(), at });
  };
  const addError = (id: string, text: string, at: string): void => {
    flushProse();
    flushWork();
    items.push({ kind: 'error', id, text, at });
  };

  for (const event of details.events) {
    const payload = obj(event.payload);
    if (event.kind === 'stream' && payload !== null) {
      const streamKind = str(payload['kind']);
      const data = str(payload['data']) ?? '';
      if (streamKind === 'heartbeat') continue;
      if (streamKind === 'stderr') {
        const key = event.stepId ?? 'task';
        const block = diagnostics.get(key) ?? { lines: [], at: event.createdAt };
        block.lines.push(data);
        diagnostics.set(key, block);
        continue;
      }
      if (streamKind === 'artifact') continue; // surfaced via the artifact event
      if (streamKind !== 'stdout') continue;
      handleStdoutLine(event, data);
      continue;
    }
    switch (event.kind) {
      case 'transition': {
        const to = str(payload?.['to']);
        if (str(payload?.['reason']) === 'retry') {
          // Errors from earlier attempts are history, not the current problem.
          flushProse();
          flushWork();
          for (const item of items) if (item.kind === 'error') item.stale = true;
        }
        if (to === undefined || to === 'CREATED' || to === 'COMPLETED') break;
        const reason = str(payload?.['reason']);
        const tone: WorkTone = to === 'FAILED' || to === 'BLOCKED' ? 'error' : 'neutral';
        addWork({ id: event.id, icon: 'state', label: STATE_LABELS[to] ?? to.toLowerCase(), ...(reason !== undefined && reason !== 'created' ? { detail: reason } : {}), tone, at: event.createdAt });
        break;
      }
      case 'artifact':
        addWork({ id: event.id, icon: 'artifact', label: 'Saved output', tone: 'neutral', at: event.createdAt });
        break;
      case 'approval': {
        const summary = str(payload?.['summary']) ?? 'Approval requested';
        addWork({ id: event.id, icon: 'approval', label: summary, tone: 'neutral', at: event.createdAt });
        break;
      }
      case 'error': {
        const text = str(payload?.['error']) ?? str(payload?.['message']) ?? (typeof event.payload === 'string' ? event.payload : JSON.stringify(event.payload));
        addError(event.id, text, event.createdAt);
        break;
      }
      case 'log': {
        const text = str(payload?.['message']) ?? str(payload?.['text']) ?? (typeof event.payload === 'string' ? event.payload : undefined);
        if (isAgentFallbackEvent(event)) {
          if (text !== undefined) addNotice(event.id, text, event.createdAt);
          break;
        }
        const detail = str(payload?.['detail']);
        const kind = str(payload?.['kind']);
        const key = str(payload?.['key']) ?? str(payload?.['toolCallId']);
        const status = str(payload?.['status']);
        const source = str(payload?.['source']);
        const tone = toneForStatus(status);
        const existing = key !== undefined ? byKey.get(key) : undefined;
        // A completion update only carries a key and status; enrich the row
        // that the matching start event already added. The row may live in an
        // earlier group if assistant prose was flushed in between.
        if (existing !== undefined) {
          if (text !== undefined) existing.label = kind === 'reasoning' ? firstLine(text) : text.trim();
          if (detail !== undefined) existing.detail = detail;
          if (kind !== undefined) existing.icon = iconForLogKind(kind);
          if (source !== undefined) existing.source = source;
          if (status !== undefined) existing.tone = tone;
          break;
        }
        if (text === undefined && detail === undefined) break;
        const label = kind === 'reasoning' ? firstLine(text ?? detail ?? 'Thinking') : (text ?? detail ?? 'Activity').trim();
        if (label === '') break;
        const entry: WorkEntry = {
          id: key !== undefined ? `log:${key}:${event.id}` : event.id,
          icon: iconForLogKind(kind),
          label,
          ...(detail !== undefined ? { detail } : kind === 'reasoning' && text !== undefined ? { detail: text } : {}),
          tone,
          at: event.createdAt,
          ...(key !== undefined ? { key } : {}),
          ...(source !== undefined ? { source } : {}),
        };
        if (key !== undefined) byKey.set(key, entry);
        addWork(entry);
        break;
      }
      default:
        break;
    }
  }
  flushProse();
  flushWork();
  // A finished task with no reply: the agent's stderr is the explanation, so
  // show it as the error instead of hiding it in diagnostics.
  const terminal = task.state === 'COMPLETED' || task.state === 'FAILED' || task.state === 'CANCELLED';
  const noReply = !items.some((item) => item.kind === 'assistant');
  for (const [key, block] of diagnostics) {
    const text = block.lines.join('\n').trim();
    if (text === '') continue;
    if (terminal && noReply) items.push({ kind: 'error', id: `diag-error:${key}`, text: `The agent finished without a reply. It reported:\n${text}`, at: block.at });
    else items.push({ kind: 'diagnostics', id: `diag:${key}`, text, at: block.at });
  }
  return items;

  function handleStdoutLine(event: TaskEvent, line: string): void {
    const trimmed = line.trim();
    let parsed: Json | null = null;
    if (trimmed.startsWith('{')) {
      try { parsed = obj(JSON.parse(trimmed)); } catch { parsed = null; }
    }
    if (parsed === null || str(parsed['type']) === undefined) {
      if (prose === null) {
        flushWork();
        prose = { lines: [], at: event.createdAt, id: `reply:${event.id}` };
      }
      prose.lines.push(line);
      return;
    }
    const type = str(parsed['type'])!;
    if (type === 'error' || type === 'turn.failed') {
      const error = obj(parsed['error']);
      addError(event.id, str(error?.['message']) ?? str(parsed['message']) ?? 'The agent reported an error', event.createdAt);
      return;
    }
    if (type === 'turn.completed') {
      const usage = obj(parsed['usage']);
      const input = typeof usage?.['input_tokens'] === 'number' ? usage['input_tokens'] : undefined;
      const output = typeof usage?.['output_tokens'] === 'number' ? usage['output_tokens'] : undefined;
      if (input !== undefined || output !== undefined) {
        addWork({ id: event.id, icon: 'state', label: 'Turn finished', detail: `${(input ?? 0).toLocaleString()} input · ${(output ?? 0).toLocaleString()} output tokens`, tone: 'neutral', at: event.createdAt });
      }
      return;
    }
    if (!type.startsWith('item.')) return; // thread.started, turn.started, …
    const item = obj(parsed['item']);
    if (item === null) return;
    const itemType = str(item['type']);
    const itemId = str(item['id']) ?? event.id;
    const completed = type === 'item.completed';
    if (itemType === 'agent_message') {
      if (completed) addReply(`reply:${itemId}:${event.id}`, str(item['text']) ?? '', event.createdAt);
      return;
    }
    const entry = workEntryFor(itemType, item, completed, event, itemId);
    if (entry === null) return;
    const existing = byItemId.get(itemId);
    if (existing !== undefined) {
      Object.assign(existing, entry, { id: existing.id });
      return;
    }
    byItemId.set(itemId, entry);
    addWork(entry);
  }
}

/** The latest thing an agent did (ignoring diagnostic notices). */
export function latestActivity(items: TimelineItem[]): WorkEntry | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind !== 'work') continue;
    const entries = item.entries.filter((entry) => entry.notice !== true);
    const latest = entries[entries.length - 1];
    if (latest !== undefined) return latest;
  }
  return undefined;
}

function workEntryFor(itemType: string | undefined, item: Json, completed: boolean, event: TaskEvent, itemId: string): WorkEntry | null {
  const base = { id: `${itemId}:${event.id}`, at: event.createdAt };
  switch (itemType) {
    case 'reasoning': {
      const text = str(item['text']);
      if (!completed || text === undefined || text.trim() === '') return null;
      return { ...base, icon: 'thinking', label: firstLine(text), detail: text.trim(), tone: 'neutral' };
    }
    case 'command_execution': {
      const command = str(item['command']) ?? 'command';
      const exit = typeof item['exit_code'] === 'number' ? item['exit_code'] : undefined;
      const output = str(item['aggregated_output']);
      const status = str(item['status']);
      const tone: WorkTone = !completed || status === 'in_progress' ? 'running' : exit !== undefined && exit !== 0 ? 'error' : 'success';
      return { ...base, icon: 'terminal', label: command.replace(/^(?:\/bin\/)?(?:bash|zsh|sh) -lc ['"]?|['"]$/g, ''), ...(output !== undefined && output.trim() !== '' ? { detail: output.trimEnd() } : {}), tone };
    }
    case 'file_change': {
      const changes = Array.isArray(item['changes']) ? item['changes'].map(obj).filter((c): c is Json => c !== null) : [];
      const paths = changes.map((c) => `${str(c['kind']) ?? 'update'} ${str(c['path']) ?? ''}`.trim());
      const label = changes.length === 1 ? `Edited ${str(changes[0]!['path']) ?? 'a file'}` : `Edited ${changes.length} files`;
      return { ...base, icon: 'file', label, ...(paths.length > 0 ? { detail: paths.join('\n') } : {}), tone: str(item['status']) === 'failed' ? 'error' : 'success' };
    }
    case 'mcp_tool_call': {
      const name = [str(item['server']), str(item['tool'])].filter(Boolean).join('.');
      return { ...base, icon: 'tool', label: `Called ${name || 'tool'}`, tone: completed ? (str(item['status']) === 'failed' ? 'error' : 'success') : 'running' };
    }
    case 'web_search':
      return { ...base, icon: 'search', label: `Searched “${str(item['query']) ?? ''}”`, tone: 'neutral' };
    case 'todo_list': {
      const todos = Array.isArray(item['items']) ? item['items'].map(obj).filter((t): t is Json => t !== null) : [];
      const done = todos.filter((t) => t['completed'] === true).length;
      return { ...base, icon: 'plan', label: `Plan · ${done}/${todos.length} done`, detail: todos.map((t) => `${t['completed'] === true ? '✓' : '○'} ${str(t['text']) ?? ''}`).join('\n'), tone: 'neutral' };
    }
    case 'error':
      // Item-level errors are non-fatal notices (config warnings, fallbacks);
      // fatal failures arrive as top-level `error` / `turn.failed` events.
      return { ...base, icon: 'state', label: `Notice: ${str(item['message']) ?? 'agent warning'}`, ...(str(item['message']) ? { detail: str(item['message'])! } : {}), tone: 'neutral', notice: true };
    default:
      return null;
  }
}
