import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { PermissionProfile, Task } from '@shared/domain';
import type { QueuedMessage, QueuedMessageMode } from '@shared/message-queue';
import {
  AGENT_ICON_PATTERN, MAX_AGENT_ICON_CHARS, SANDBOX_AGENT_COLORS, SANDBOX_MCP_KEY, SANDBOX_TOOL_GROUPS,
  type AgentCliChoice, type AgentGroup, type AgentGroupMessage,
  type SandboxAgent, type SandboxAgentInput, type SandboxApprovalPolicy, type SandboxToolGroup,
} from '@shared/sandbox-agents';
import type { Store } from '../db/types';
import type { CodexMcpServer } from '../adapters/objective-cli-adapter';
import { ToolGate, type ToolApprover } from '../adapters/tool-gate';
import { LOCK_TOOL, RETURN_FILE_TOOL, UNLOCK_TOOL, type SandboxGateway, type GatewaySession } from './sandbox-gateway';
import { SANDBOX_MEMORY_FILE, SANDBOX_SHARED_DIR, SANDBOX_WORKSPACE_DIR, type SandboxEndpoint, type SandboxManager } from './sandbox-manager';

// Sandbox agents: their definitions, which thread each one runs, and the
// per-run wiring — the sandbox container for the thread, the approval-gated
// MCP gateway the CLI connects to, the agent's standing instructions, and the
// CLI fallback order its runs follow when one CLI runs out of usage.

interface AgentRow {
  id: string; name: string; description: string; instructions: string; clis: string; models: string; tools: string;
  approval: SandboxApprovalPolicy; color: string; icon: string; created_at: string; updated_at: string;
}

const GROUPS = new Set<SandboxToolGroup>(SANDBOX_TOOL_GROUPS.map((group) => group.id));
const parseList = (text: string): string[] => {
  try { const value = JSON.parse(text) as unknown; return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; } catch { return []; }
};

const MODEL_ID = /^[\w./:@-]{1,100}$/;
const EFFORT_ID = /^[a-z]{2,12}$/;
function parseModels(text: string | undefined): Record<string, AgentCliChoice> {
  try { return cleanModels(JSON.parse(text ?? '{}') as unknown); } catch { return {}; }
}
/** Keeps well-formed per-CLI choices; `only` limits them to the agent's own CLIs. */
function cleanModels(raw: unknown, only?: readonly string[]): Record<string, AgentCliChoice> {
  const out: Record<string, AgentCliChoice> = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [cli, value] of Object.entries(raw as Record<string, unknown>)) {
    if (only !== undefined && !only.includes(cli)) continue;
    if (value === null || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    const choice: AgentCliChoice = {};
    if (typeof v['model'] === 'string' && MODEL_ID.test(v['model'])) choice.model = v['model'];
    if (typeof v['effort'] === 'string' && EFFORT_ID.test(v['effort'])) choice.effort = v['effort'];
    if (Object.keys(choice).length > 0) out[cli] = choice;
  }
  return out;
}

function toAgent(row: AgentRow): SandboxAgent {
  return {
    id: row.id, name: row.name, description: row.description, instructions: row.instructions,
    clis: parseList(row.clis), models: parseModels(row.models), tools: parseList(row.tools).filter((t): t is SandboxToolGroup => GROUPS.has(t as SandboxToolGroup)),
    approval: row.approval, color: row.color, icon: row.icon, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export { SANDBOX_MCP_KEY };

export interface SandboxAgentServiceDeps {
  store: Store;
  manager: SandboxManager;
  gateway: SandboxGateway;
  approver: ToolApprover;
  autoApprove: () => boolean;
  /** Whether an agent CLI (adapter id) is installed and usable. */
  cliAvailable: (id: string) => boolean;
  /** Record a line in the thread's activity (e.g. "Starting the sandbox"). */
  log: (taskId: string, stepId: string, payload: Record<string, unknown>) => void;
  /** Store a file an agent handed back and show it in the task's chat. */
  deliverFile: (taskId: string, stepId: string, file: { name: string; bytes: Buffer }) => void;
  /** The hidden workspace agent chats use when no project is chosen. */
  agentWorkspace: () => string;
}

interface ActiveRun { agentId: string; session: GatewaySession }

/** Starts a task (TaskRunner.create); set once the runner exists. */
export type TaskCreator = (input: {
  workspaceId: string; objective: string; parentTaskId?: string; agentId?: string; attachmentIds?: readonly string[];
  onCreated?: (task: Task) => void;
}) => Promise<Task>;

/** Holds a message for a task that is still working (TaskRunner.enqueueMessage). */
export type MessageEnqueuer = (input: {
  taskId: string; objective: string; mode: QueuedMessageMode; attachmentIds?: readonly string[];
}) => Promise<QueuedMessage>;

/** States in which a thread is busy, so a new message is steered or queued rather than started. */
const BUSY_STATES = new Set(['CREATED', 'CONTEXT_LOADING', 'PLANNING', 'RUNNING', 'VERIFYING', 'WAITING_FOR_APPROVAL']);
const MAX_QUEUED_OBJECTIVE = 10_000;

const MAX_GROUP_CONTEXT = 6000;
/** Where attached files are copied inside the sandbox. */
const SANDBOX_ATTACHMENT_DIR = '/home/gem/attachments';
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** A safe file name for the sandbox, unique within one task's files. */
function sandboxName(path: string, taken: Set<string>): string {
  const base = basename(path).replace(/[^\w.@+-]+/g, '_').slice(0, 120) || 'file';
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${n}-${base}`;
  taken.add(name);
  return name;
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Read a file's bytes out of a sandbox. Tries the sandbox's download
 * endpoint, then falls back to base64 over its shell API; the fallback
 * checks the byte count so a cut-off transfer is never delivered.
 */
export async function readSandboxFile(endpoint: SandboxEndpoint, path: string, fetcher: typeof fetch = fetch): Promise<Buffer> {
  const headers = { 'X-AIO-API-Key': endpoint.apiKey };
  try {
    const response = await fetcher(`${endpoint.baseUrl}/v1/file/download?path=${encodeURIComponent(path)}`, { headers, signal: AbortSignal.timeout(120_000) });
    const type = response.headers.get('content-type') ?? '';
    // A JSON body here is an error envelope (or a different API), not the file — unless the file is JSON itself.
    if (response.ok && (!type.includes('application/json') || /\.json$/i.test(path))) {
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_UPLOAD_BYTES) throw new SandboxFileError('The file is larger than 25 MB.');
      if (bytes.length > 0) return bytes;
    }
  } catch (error) {
    if (error instanceof SandboxFileError) throw error;
  }
  const quoted = shellQuote(path);
  const response = await fetcher(`${endpoint.baseUrl}/v1/shell/exec`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ command: `test -f ${quoted} && stat -c %s -- ${quoted} && base64 -w0 -- ${quoted}` }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.json().catch(() => undefined) as { data?: { output?: unknown }; output?: unknown } | undefined;
  const output = typeof body?.data?.output === 'string' ? body.data.output : typeof body?.output === 'string' ? body.output : '';
  const match = /^\s*(\d+)\s+([A-Za-z0-9+/=\s]*)$/.exec(output);
  if (!response.ok || match === null) throw new SandboxFileError(`No file was found at ${path}. Save the file in the sandbox first, then give its absolute path.`);
  const size = Number(match[1]);
  if (size > MAX_UPLOAD_BYTES) throw new SandboxFileError('The file is larger than 25 MB.');
  const bytes = Buffer.from(match[2]!.replace(/\s+/g, ''), 'base64');
  if (bytes.length !== size) throw new SandboxFileError('The file could not be copied out of the sandbox completely.');
  if (size === 0) throw new SandboxFileError('The file is empty.');
  return bytes;
}

export class SandboxFileError extends Error {}

export class SandboxAgentService {
  /** Gateway sessions per task, closed when the task settles. */
  private readonly runs = new Map<string, ActiveRun[]>();

  private createTask: TaskCreator | undefined;
  private enqueue: MessageEnqueuer | undefined;
  /** Files already copied into a running sandbox (keyed by its address and key). */
  private readonly uploaded = new Set<string>();

  constructor(private readonly deps: SandboxAgentServiceDeps) {}

  setTaskCreator(create: TaskCreator): void {
    this.createTask = create;
  }

  setMessageQueue(enqueue: MessageEnqueuer): void {
    this.enqueue = enqueue;
  }

  /** Where agent chats without a project run (a hidden, non-git workspace). */
  agentWorkspaceId(): string {
    return this.deps.agentWorkspace();
  }

  // ---- definitions ----------------------------------------------------------

  list(): SandboxAgent[] {
    return (this.deps.store.db.prepare('SELECT * FROM sandbox_agents ORDER BY created_at').all() as AgentRow[]).map(toAgent);
  }

  get(id: string): SandboxAgent | undefined {
    const row = this.deps.store.db.prepare('SELECT * FROM sandbox_agents WHERE id = ?').get(id) as AgentRow | undefined;
    return row === undefined ? undefined : toAgent(row);
  }

  private validate(input: SandboxAgentInput): SandboxAgentInput {
    const name = input.name.trim();
    if (name === '' || name.length > 60) throw new Error('Give the agent a name of up to 60 characters.');
    const clis = [...new Set(input.clis)].filter((id) => /^[\w:.-]{1,200}$/.test(id));
    if (clis.length === 0) throw new Error('Choose at least one CLI for the agent to run on.');
    const tools = [...new Set(input.tools)].filter((tool) => GROUPS.has(tool));
    if (tools.length === 0) throw new Error('Give the agent at least one sandbox tool.');
    const color = /^#[0-9a-f]{6}$/i.test(input.color) ? input.color : SANDBOX_AGENT_COLORS[0];
    const icon = input.icon !== undefined && input.icon.length <= MAX_AGENT_ICON_CHARS && AGENT_ICON_PATTERN.test(input.icon) ? input.icon : '';
    return { name, icon, description: input.description.trim().slice(0, 300), instructions: input.instructions.trim().slice(0, 8000), clis, models: cleanModels(input.models, clis), tools, approval: input.approval, color };
  }

  create(input: SandboxAgentInput): SandboxAgent {
    const clean = this.validate(input);
    const now = new Date().toISOString();
    const id = randomUUID();
    this.deps.store.db.prepare(`INSERT INTO sandbox_agents (id, name, description, instructions, clis, models, tools, approval, color, icon, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, clean.name, clean.description, clean.instructions, JSON.stringify(clean.clis), JSON.stringify(clean.models ?? {}), JSON.stringify(clean.tools), clean.approval, clean.color, clean.icon ?? '', now, now);
    return this.get(id)!;
  }

  update(id: string, input: SandboxAgentInput): SandboxAgent {
    if (this.get(id) === undefined) throw new Error('That agent no longer exists.');
    const clean = this.validate(input);
    this.deps.store.db.prepare(`UPDATE sandbox_agents SET name=?, description=?, instructions=?, clis=?, models=?, tools=?, approval=?, color=?, icon=?, updated_at=? WHERE id=?`)
      .run(clean.name, clean.description, clean.instructions, JSON.stringify(clean.clis), JSON.stringify(clean.models ?? {}), JSON.stringify(clean.tools), clean.approval, clean.color, clean.icon ?? '', new Date().toISOString(), id);
    return this.get(id)!;
  }

  remove(id: string): void {
    this.deps.store.db.prepare('DELETE FROM sandbox_agents WHERE id = ?').run(id);
    void this.deps.manager.forget(id);
  }

  // ---- threads --------------------------------------------------------------

  /** The CLI a new run of this agent starts on: its first available one. */
  startingCli(agentId: string, preferred?: string): string {
    const agent = this.get(agentId);
    if (agent === undefined) throw new Error('That agent no longer exists.');
    if (preferred !== undefined) {
      if (!agent.clis.includes(preferred)) throw new Error(`${agent.name} isn’t set up to run on ${preferred}.`);
      if (!this.deps.cliAvailable(preferred)) throw new Error(`${preferred} isn’t available right now. Check Connections, or pick another CLI.`);
      return preferred;
    }
    const cli = agent.clis.find((id) => this.deps.cliAvailable(id));
    if (cli === undefined) throw new Error(`None of ${agent.name}’s CLIs is available. Edit the agent or check Connections.`);
    return cli;
  }

  bindThread(threadId: string, agentId: string): void {
    this.deps.store.db.prepare('INSERT OR REPLACE INTO thread_sandbox_agents (thread_id, agent_id, created_at) VALUES (?, ?, ?)')
      .run(threadId, agentId, new Date().toISOString());
  }

  /** The agent that runs a task's thread, if any. */
  agentForTask(task: Pick<Task, 'id' | 'threadId'>): SandboxAgent | undefined {
    const row = this.deps.store.db.prepare('SELECT agent_id FROM thread_sandbox_agents WHERE thread_id = ?').get(task.threadId ?? task.id) as { agent_id: string } | undefined;
    return row === undefined ? undefined : this.get(row.agent_id);
  }

  /** Thread id → agent id, for the renderer to label threads. */
  threadAgents(): Record<string, string> {
    const rows = this.deps.store.db.prepare('SELECT thread_id, agent_id FROM thread_sandbox_agents').all() as Array<{ thread_id: string; agent_id: string }>;
    return Object.fromEntries(rows.map((row) => [row.thread_id, row.agent_id]));
  }

  /** The model and effort the task's agent chose for one CLI, if any. */
  choiceFor(task: Pick<Task, 'id' | 'threadId'>, cliId: string): AgentCliChoice | undefined {
    return this.agentForTask(task)?.models[cliId];
  }

  /**
   * Fallback order for a task's step: the agent's CLIs in its order, so a CLI
   * that is out of usage hands over to the next one the user chose.
   */
  fallbackOrder(task: Pick<Task, 'id' | 'threadId'>): string[] | undefined {
    return this.agentForTask(task)?.clis;
  }

  // ---- group chats ----------------------------------------------------------

  listGroups(): AgentGroup[] {
    const groups = this.deps.store.db.prepare('SELECT id, name, created_at, updated_at FROM agent_groups ORDER BY updated_at DESC').all() as Array<{ id: string; name: string; created_at: string; updated_at: string }>;
    const members = this.deps.store.db.prepare('SELECT group_id, agent_id FROM agent_group_members').all() as Array<{ group_id: string; agent_id: string }>;
    return groups.map((group) => ({
      id: group.id, name: group.name, createdAt: group.created_at, updatedAt: group.updated_at,
      agentIds: members.filter((member) => member.group_id === group.id).map((member) => member.agent_id),
    }));
  }

  createGroup(name: string, agentIds: string[]): AgentGroup {
    const clean = name.trim().slice(0, 60);
    const members = [...new Set(agentIds)].filter((id) => this.get(id) !== undefined);
    if (members.length < 2) throw new Error('A group needs at least two agents.');
    const id = randomUUID();
    const now = new Date().toISOString();
    const insert = this.deps.store.db.prepare('INSERT INTO agent_group_members (group_id, agent_id) VALUES (?, ?)');
    this.deps.store.db.transaction(() => {
      this.deps.store.db.prepare('INSERT INTO agent_groups (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(id, clean === '' ? members.map((member) => this.get(member)!.name).join(', ').slice(0, 60) : clean, now, now);
      for (const member of members) insert.run(id, member);
    })();
    return this.listGroups().find((group) => group.id === id)!;
  }

  removeGroup(id: string): void {
    this.deps.store.db.prepare('DELETE FROM agent_groups WHERE id = ?').run(id);
  }

  groupMessages(groupId: string): AgentGroupMessage[] {
    const messages = this.deps.store.db.prepare('SELECT id, text, created_at FROM agent_group_messages WHERE group_id = ? ORDER BY created_at').all(groupId) as Array<{ id: string; text: string; created_at: string }>;
    const replies = this.deps.store.db.prepare(`SELECT r.message_id, r.agent_id, r.task_id FROM agent_group_replies r
      JOIN agent_group_messages m ON m.id = r.message_id WHERE m.group_id = ?`).all(groupId) as Array<{ message_id: string; agent_id: string; task_id: string }>;
    // Replies held for a member who was busy: a task once dispatched, waiting until then.
    const held = this.deps.store.db.prepare(`SELECT p.message_id, p.agent_id, p.queue_id, q.mode, q.status, q.dispatched_task_id FROM agent_group_pending p
      JOIN agent_group_messages m ON m.id = p.message_id JOIN task_message_queue q ON q.id = p.queue_id WHERE m.group_id = ?`)
      .all(groupId) as Array<{ message_id: string; agent_id: string; queue_id: string; mode: QueuedMessageMode; status: string; dispatched_task_id: string | null }>;
    return messages.map((message) => {
      const mine = held.filter((row) => row.message_id === message.id);
      const waiting = Object.fromEntries(mine.filter((row) => row.status === 'pending' || row.status === 'dispatching').map((row) => [row.agent_id, { queueId: row.queue_id, mode: row.mode }]));
      return {
        id: message.id, text: message.text, createdAt: message.created_at,
        replies: Object.fromEntries([
          ...replies.filter((reply) => reply.message_id === message.id).map((reply): [string, string] => [reply.agent_id, reply.task_id]),
          ...mine.filter((row) => row.dispatched_task_id !== null).map((row): [string, string] => [row.agent_id, row.dispatched_task_id!]),
        ]),
        ...(Object.keys(waiting).length > 0 ? { waiting } : {}),
      };
    });
  }

  /**
   * Send a message to a group: each targeted member answers in its own thread
   * for this group (continuing it after the first message). `context` is what
   * the other members said recently, so they can build on each other. A
   * member still working on an earlier message gets this one by `mode`:
   * queued behind that work (the default), or steering it — the work is
   * stopped and this message answered next.
   */
  async sendGroup(input: { groupId: string; text: string; workspaceId?: string; agentIds?: string[]; context?: string; attachmentIds?: readonly string[]; mode?: QueuedMessageMode }): Promise<AgentGroupMessage> {
    if (this.createTask === undefined) throw new Error('Conductor is still starting. Try again in a moment.');
    const group = this.listGroups().find((item) => item.id === input.groupId);
    if (group === undefined) throw new Error('That group no longer exists.');
    const text = input.text.trim();
    if (text === '') throw new Error('Write a message first.');
    const targets = (input.agentIds ?? group.agentIds).filter((id) => group.agentIds.includes(id));
    if (targets.length === 0) throw new Error('Mention at least one member of the group.');
    const names = group.agentIds.map((id) => this.get(id)?.name).filter((name): name is string => name !== undefined);
    const messageId = randomUUID();
    const now = new Date().toISOString();
    this.deps.store.db.prepare('INSERT INTO agent_group_messages (id, group_id, text, created_at) VALUES (?, ?, ?, ?)').run(messageId, group.id, text, now);
    this.deps.store.db.prepare('UPDATE agent_groups SET updated_at = ? WHERE id = ?').run(now, group.id);
    const failures: string[] = [];
    for (const agentId of targets) {
      const agent = this.get(agentId);
      if (agent === undefined) continue;
      const others = names.filter((name) => name !== agent.name);
      const objective = [
        `[Group chat “${group.name}” — you are ${agent.name}; also here: ${others.join(', ') || 'nobody else'}. Reply to the user's message; build on what the others said rather than repeating it.]`,
        input.context !== undefined && input.context.trim() !== '' ? `What the others said recently:\n${input.context.trim().slice(-MAX_GROUP_CONTEXT)}` : '',
        `Message:\n${text}`,
      ].filter((part) => part !== '').join('\n\n');
      const thread = (this.deps.store.db.prepare('SELECT thread_id FROM agent_group_members WHERE group_id = ? AND agent_id = ?').get(group.id, agentId) as { thread_id: string | null } | undefined)?.thread_id ?? null;
      const parent = thread === null ? undefined : this.deps.store.db.prepare('SELECT id, state FROM tasks WHERE thread_id = ? OR id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(thread, thread) as { id: string; state: string } | undefined;
      try {
        if (parent !== undefined && BUSY_STATES.has(parent.state) && this.enqueue !== undefined) {
          // Too long to hold with the others' context: send the message itself.
          const held = objective.length <= MAX_QUEUED_OBJECTIVE ? objective : text;
          const entry = await this.enqueue({
            taskId: parent.id, objective: held, mode: input.mode ?? 'queue',
            ...(input.attachmentIds !== undefined && input.attachmentIds.length > 0 ? { attachmentIds: input.attachmentIds } : {}),
          });
          this.deps.store.db.prepare('INSERT INTO agent_group_pending (message_id, agent_id, queue_id) VALUES (?, ?, ?)').run(messageId, agentId, entry.id);
          continue;
        }
        await this.createTask({
          workspaceId: input.workspaceId ?? this.agentWorkspaceId(),
          objective,
          ...(input.attachmentIds !== undefined && input.attachmentIds.length > 0 ? { attachmentIds: input.attachmentIds } : {}),
          ...(parent !== undefined ? { parentTaskId: parent.id } : { agentId: this.startingCli(agentId) }),
          onCreated: (task) => {
            const threadId = task.threadId ?? task.id;
            if (parent === undefined) {
              this.bindThread(threadId, agentId);
              this.deps.store.db.prepare('UPDATE agent_group_members SET thread_id = ? WHERE group_id = ? AND agent_id = ?').run(threadId, group.id, agentId);
            }
            this.deps.store.db.prepare('INSERT INTO agent_group_replies (message_id, agent_id, task_id) VALUES (?, ?, ?)').run(messageId, agentId, task.id);
          },
        });
      } catch (error) {
        failures.push(`${agent.name}: ${error instanceof Error ? error.message : 'could not start'}`);
      }
    }
    if (failures.length === targets.length) throw new Error(failures.join(' '));
    return this.groupMessages(group.id).find((message) => message.id === messageId)!;
  }

  /** Threads that belong to group chats (not an agent's 1:1 chat), with their group. */
  groupThreadMap(): Record<string, string> {
    const rows = this.deps.store.db.prepare('SELECT thread_id, group_id FROM agent_group_members WHERE thread_id IS NOT NULL').all() as Array<{ thread_id: string; group_id: string }>;
    return Object.fromEntries(rows.map((row) => [row.thread_id, row.group_id]));
  }

  // ---- runs -----------------------------------------------------------------

  /** The files attached to a task, as absolute paths on this Mac. */
  private attachmentFiles(taskId: string): Array<{ path: string; name: string }> {
    const rows = this.deps.store.db.prepare('SELECT materialized_path FROM task_attachments WHERE task_id = ? AND materialized_path IS NOT NULL ORDER BY ordinal').all(taskId) as Array<{ materialized_path: string }>;
    const taken = new Set<string>();
    return rows.map((row) => ({ path: row.materialized_path, name: sandboxName(row.materialized_path, taken) }));
  }

  /** Copy a task's attached files into the sandbox, once per sandbox. Never fails the run. */
  private async uploadAttachments(taskId: string, stepId: string, agentName: string, endpoint: import('./sandbox-manager').SandboxEndpoint): Promise<void> {
    const files = this.attachmentFiles(taskId).filter((file) => !this.uploaded.has(`${endpoint.baseUrl}|${endpoint.apiKey}|${taskId}|${file.name}`));
    if (files.length === 0) return;
    const failed: string[] = [];
    for (const file of files) {
      try {
        if ((await stat(file.path)).size > MAX_UPLOAD_BYTES) throw new Error('too large');
        const response = await fetch(`${endpoint.baseUrl}/v1/file/write`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'X-AIO-API-Key': endpoint.apiKey },
          body: JSON.stringify({ file: `${SANDBOX_ATTACHMENT_DIR}/${taskId.slice(0, 8)}/${file.name}`, content: (await readFile(file.path)).toString('base64'), encoding: 'base64' }),
          signal: AbortSignal.timeout(120_000),
        });
        const body = await response.json().catch(() => undefined) as { success?: boolean } | undefined;
        if (!response.ok || body?.success === false) throw new Error(`HTTP ${response.status}`);
        this.uploaded.add(`${endpoint.baseUrl}|${endpoint.apiKey}|${taskId}|${file.name}`);
      } catch { failed.push(file.name); }
    }
    this.deps.log(taskId, stepId, {
      message: failed.length === 0 ? `Copied ${files.length} attached file${files.length === 1 ? '' : 's'} into the sandbox` : `Could not copy ${failed.join(', ')} into the sandbox`,
      kind: 'tool', key: `sandbox-files:${stepId}`, status: failed.length === 0 ? 'completed' : 'failed', source: agentName,
    });
  }

  /**
   * Wire one step of an agent's thread: the gateway the CLI connects to (the
   * sandbox itself starts on the first tool use) and the agent's standing
   * instructions. Returns nothing for threads without an agent.
   */
  async prepareStep(task: Task, stepId: string, mode: PermissionProfile): Promise<{ server: CodexMcpServer; guidance: string } | undefined> {
    const agent = this.agentForTask(task);
    if (agent === undefined) return undefined;
    const gate = new ToolGate(mode, this.deps.approver, { taskId: task.id, stepId }, { autoApprove: this.deps.autoApprove });
    let started: Promise<import('./sandbox-manager').SandboxEndpoint> | undefined;
    const resumed = this.resumedWork(task, stepId, agent.id);
    const session = await this.deps.gateway.open({
      agentName: agent.name,
      tools: agent.tools,
      approval: agent.approval,
      decide: (request, signal) => gate.decide(request, signal),
      lockOwner: { id: task.id, name: agent.name },
      returnFile: async (input, endpoint) => {
        const bytes = await readSandboxFile(endpoint, input.path);
        const name = sandboxName(input.name ?? input.path, new Set());
        this.deps.deliverFile(task.id, stepId, { name, bytes });
        this.deps.log(task.id, stepId, { message: `Handed back ${name}`, kind: 'tool', key: `sandbox-return:${stepId}:${name}`, status: 'completed', source: agent.name });
        return `${name} (${bytes.length} bytes) is now in the chat for the user to open and download. Do not paste its contents; just say what it is.`;
      },
      sandbox: () => {
        started ??= (async () => {
          const already = this.deps.manager.endpoint(agent.id);
          if (already === undefined) {
            this.deps.log(task.id, stepId, { message: 'Starting the sandbox', kind: 'tool', key: `sandbox-start:${stepId}`, status: 'running', source: agent.name });
          }
          try {
            const endpoint = await this.deps.manager.acquire({ taskId: task.id, agentId: agent.id, agentName: agent.name });
            if (already === undefined) this.deps.log(task.id, stepId, { message: 'Sandbox ready', kind: 'tool', key: `sandbox-start:${stepId}`, status: 'completed', source: agent.name });
            await this.uploadAttachments(task.id, stepId, agent.name, endpoint);
            return endpoint;
          } catch (error) {
            const text = error instanceof Error ? error.message : 'unknown error';
            this.deps.log(task.id, stepId, { message: /^Can’t start another/.test(text) ? text : `The sandbox could not start: ${text}`, kind: 'tool', key: `sandbox-start:${stepId}`, status: 'failed', source: agent.name });
            started = undefined;
            throw error;
          }
        })();
        return started;
      },
    });
    this.runs.set(task.id, [...(this.runs.get(task.id) ?? []), { agentId: agent.id, session }]);
    const groups = SANDBOX_TOOL_GROUPS.filter((group) => agent.tools.includes(group.id)).map((group) => group.label.toLowerCase());
    const approvals = agent.approval === 'none' ? '' : agent.approval === 'all'
      ? ' Every sandbox action waits for the user to approve it.'
      : ' Commands, code, file changes and browser actions that act on a page wait for the user to approve them; if one is declined, do not retry it — continue another way or explain what you need.';
    const files = this.attachmentFiles(task.id);
    const fileNote = files.length === 0 ? ''
      : `The user attached ${files.length} file${files.length === 1 ? '' : 's'}. They are copied into your sandbox as: ${files.map((file) => `${SANDBOX_ATTACHMENT_DIR}/${task.id.slice(0, 8)}/${file.name}`).join(', ')}. Work with them there${files.some((file) => /\.zip$/i.test(file.name)) ? '; unzip archives in the sandbox to read their files' : ''}.`;
    const guidance = [
      `You are "${agent.name}"${agent.description !== '' ? ` — ${agent.description}` : ''}.`,
      agent.instructions,
      `You have an isolated sandbox computer, available through the "${SANDBOX_MCP_KEY}" MCP server (${groups.join(', ')}).`
      + ' Do ALL of your work there: browse the web with its browser tools, run commands with its terminal, and handle files in its file tools.'
      + ' Your own shell, web search, web fetch and file-editing tools are disabled for this agent, so do not try them (no curl, no local web search).'
      + `${approvals}`,
      `To give the user a file (a PDF, Word document, zip, spreadsheet, image — any type), create it in the sandbox, then call the "${RETURN_FILE_TOOL}" tool with its absolute path. It appears in the chat, where the user can open and download it. Use this for files you built with sandbox tools; do not paste a file's contents into your reply instead.`,
      `Your sandbox is rebuilt from scratch whenever it has been idle, so only two folders keep their contents: ${SANDBOX_WORKSPACE_DIR} is your own storage and survives restarts — keep work in progress, notes, downloads and anything you will want next time there, and look in it at the start of a task for what you left earlier. ${SANDBOX_SHARED_DIR} is shared with the user's other agents and also survives restarts — put files there to pass them to another agent, and check it when you are told another agent left something for you. Other agents may be working there at the same time, so it is locked per file or folder: before you create, change, move or delete anything in ${SANDBOX_SHARED_DIR}, call "${LOCK_TOOL}" with its path (lock a subfolder to cover several files), and call "${UNLOCK_TOOL}" as soon as it is complete. Always use full paths starting with ${SANDBOX_SHARED_DIR} in commands, never "cd" into it. If you are told another agent holds the lock, do not work around it: do something else and try again shortly. Reading needs no lock. Do not delete what you did not create. Everything outside these two folders is lost when the sandbox restarts.`,
      this.memoryNote(resumed),
      fileNote,
    ].filter((line) => line.trim() !== '').join('\n\n');
    return { server: { key: SANDBOX_MCP_KEY, url: session.url }, guidance };
  }

  /**
   * Why this run may be picking up where something else left off: its sandbox
   * was rebuilt since the agent last worked, or a different CLI or model
   * is running it than last time (a switch, or a fallback within this task).
   */
  private resumedWork(task: Task, stepId: string, agentId: string): 'restart' | 'switch' | undefined {
    if ((this.runs.get(task.id)?.length ?? 0) > 0) return 'switch';
    const db = this.deps.store.db;
    const own = db.prepare('SELECT assigned_adapter_id AS adapter, execution_input AS input FROM task_steps WHERE id = ?').get(stepId) as { adapter: string | null; input: string | null } | undefined;
    const before = db.prepare(`SELECT s.assigned_adapter_id AS adapter, s.execution_input AS input FROM task_steps s JOIN tasks t ON t.id = s.task_id
      WHERE (t.thread_id = ? OR t.id = ?) AND s.id != ? AND s.assigned_adapter_id IS NOT NULL ORDER BY s.rowid DESC LIMIT 1`)
      .get(task.threadId ?? task.id, task.threadId ?? task.id, stepId) as { adapter: string | null; input: string | null } | undefined;
    const modelOf = (row: { adapter: string | null; input: string | null } | undefined): string | undefined => {
      try {
        const models = (JSON.parse(row?.input ?? '{}') as { models?: Record<string, unknown> }).models;
        const value = row?.adapter != null ? models?.[row.adapter] : undefined;
        return typeof value === 'string' ? value : undefined;
      } catch { return undefined; }
    };
    if (before !== undefined && own !== undefined && (before.adapter !== own.adapter || modelOf(before) !== modelOf(own))) return 'switch';
    return this.deps.manager.endpoint(agentId) === undefined ? 'restart' : undefined;
  }

  /** The agent's standing instructions for the shared notebook. */
  private memoryNote(resumed: 'restart' | 'switch' | undefined): string {
    const start = resumed === undefined ? ''
      : `${resumed === 'restart' ? 'Your sandbox was just (re)started' : 'A different CLI or model has just taken over from the one that was working'}, so FIRST read ${SANDBOX_MEMORY_FILE} (if it exists) and carry on from what it says before doing anything else. `;
    return `${start}Keep a shared notebook at ${SANDBOX_MEMORY_FILE}, in Markdown, that the user's other agents read after a restart or a change of model. `
      + `Under a heading with your own name, note briefly: what you are doing and why, decisions made, what is finished, what is left, and where the files are. Update it when you finish a step and before you stop. `
      + `Lock the file with "${LOCK_TOOL}" while you edit it and unlock right after; add to or edit your own section, and leave other agents' sections as they are. Keep it short and current — remove what is no longer true. Never put passwords or secrets in it.`;
  }

  /** A task settled: close its gateway sessions and let its sandbox idle out. */
  release(task: Pick<Task, 'id' | 'threadId'>): void {
    const runs = this.runs.get(task.id);
    if (runs === undefined) return;
    this.runs.delete(task.id);
    for (const run of runs) {
      run.session.dispose();
      this.deps.manager.release(run.agentId, task.id);
    }
  }
}
