import { randomUUID } from 'node:crypto';
import type { PermissionProfile, Task } from '@shared/domain';
import {
  SANDBOX_AGENT_COLORS, SANDBOX_MCP_KEY, SANDBOX_TOOL_GROUPS,
  type AgentGroup, type AgentGroupMessage,
  type SandboxAgent, type SandboxAgentInput, type SandboxApprovalPolicy, type SandboxToolGroup,
} from '@shared/sandbox-agents';
import type { Store } from '../db/types';
import type { CodexMcpServer } from '../adapters/objective-cli-adapter';
import { ToolGate, type ToolApprover } from '../adapters/tool-gate';
import type { SandboxGateway, GatewaySession } from './sandbox-gateway';
import type { SandboxManager } from './sandbox-manager';

// Sandbox agents: their definitions, which thread each one runs, and the
// per-run wiring — the sandbox container for the thread, the approval-gated
// MCP gateway the CLI connects to, the agent's standing instructions, and the
// CLI fallback order its runs follow when one CLI runs out of usage.

interface AgentRow {
  id: string; name: string; description: string; instructions: string; clis: string; tools: string;
  approval: SandboxApprovalPolicy; color: string; created_at: string; updated_at: string;
}

const GROUPS = new Set<SandboxToolGroup>(SANDBOX_TOOL_GROUPS.map((group) => group.id));
const parseList = (text: string): string[] => {
  try { const value = JSON.parse(text) as unknown; return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; } catch { return []; }
};

function toAgent(row: AgentRow): SandboxAgent {
  return {
    id: row.id, name: row.name, description: row.description, instructions: row.instructions,
    clis: parseList(row.clis), tools: parseList(row.tools).filter((t): t is SandboxToolGroup => GROUPS.has(t as SandboxToolGroup)),
    approval: row.approval, color: row.color, createdAt: row.created_at, updatedAt: row.updated_at,
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
  /** The hidden workspace agent chats use when no project is chosen. */
  agentWorkspace: () => string;
}

interface ActiveRun { agentId: string; session: GatewaySession }

/** Starts a task (TaskRunner.create); set once the runner exists. */
export type TaskCreator = (input: {
  workspaceId: string; objective: string; parentTaskId?: string; agentId?: string; attachmentIds?: readonly string[];
  onCreated?: (task: Task) => void;
}) => Promise<Task>;

const MAX_GROUP_CONTEXT = 6000;

export class SandboxAgentService {
  /** Gateway sessions per task, closed when the task settles. */
  private readonly runs = new Map<string, ActiveRun[]>();

  private createTask: TaskCreator | undefined;

  constructor(private readonly deps: SandboxAgentServiceDeps) {}

  setTaskCreator(create: TaskCreator): void {
    this.createTask = create;
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
    return { name, description: input.description.trim().slice(0, 300), instructions: input.instructions.trim().slice(0, 8000), clis, tools, approval: input.approval, color };
  }

  create(input: SandboxAgentInput): SandboxAgent {
    const clean = this.validate(input);
    const now = new Date().toISOString();
    const id = randomUUID();
    this.deps.store.db.prepare(`INSERT INTO sandbox_agents (id, name, description, instructions, clis, tools, approval, color, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, clean.name, clean.description, clean.instructions, JSON.stringify(clean.clis), JSON.stringify(clean.tools), clean.approval, clean.color, now, now);
    return this.get(id)!;
  }

  update(id: string, input: SandboxAgentInput): SandboxAgent {
    if (this.get(id) === undefined) throw new Error('That agent no longer exists.');
    const clean = this.validate(input);
    this.deps.store.db.prepare(`UPDATE sandbox_agents SET name=?, description=?, instructions=?, clis=?, tools=?, approval=?, color=?, updated_at=? WHERE id=?`)
      .run(clean.name, clean.description, clean.instructions, JSON.stringify(clean.clis), JSON.stringify(clean.tools), clean.approval, clean.color, new Date().toISOString(), id);
    return this.get(id)!;
  }

  remove(id: string): void {
    this.deps.store.db.prepare('DELETE FROM sandbox_agents WHERE id = ?').run(id);
  }

  // ---- threads --------------------------------------------------------------

  /** The CLI a new run of this agent starts on: its first available one. */
  startingCli(agentId: string): string {
    const agent = this.get(agentId);
    if (agent === undefined) throw new Error('That agent no longer exists.');
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
    return messages.map((message) => ({
      id: message.id, text: message.text, createdAt: message.created_at,
      replies: Object.fromEntries(replies.filter((reply) => reply.message_id === message.id).map((reply) => [reply.agent_id, reply.task_id])),
    }));
  }

  /**
   * Send a message to a group: each targeted member answers in its own thread
   * for this group (continuing it after the first message). `context` is what
   * the other members said recently, so they can build on each other.
   */
  async sendGroup(input: { groupId: string; text: string; workspaceId?: string; agentIds?: string[]; context?: string; attachmentIds?: readonly string[] }): Promise<AgentGroupMessage> {
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
      const parent = thread === null ? undefined : this.deps.store.db.prepare('SELECT id FROM tasks WHERE thread_id = ? OR id = ? ORDER BY created_at DESC LIMIT 1').get(thread, thread) as { id: string } | undefined;
      try {
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
    const session = await this.deps.gateway.open({
      agentName: agent.name,
      tools: agent.tools,
      approval: agent.approval,
      decide: (request, signal) => gate.decide(request, signal),
      sandbox: () => {
        started ??= (async () => {
          const already = this.deps.manager.endpoint(agent.id);
          if (already === undefined) {
            this.deps.log(task.id, stepId, { message: 'Starting the sandbox', kind: 'tool', key: `sandbox-start:${stepId}`, status: 'running', source: agent.name });
          }
          try {
            const endpoint = await this.deps.manager.acquire({ taskId: task.id, agentId: agent.id, agentName: agent.name });
            if (already === undefined) this.deps.log(task.id, stepId, { message: 'Sandbox ready', kind: 'tool', key: `sandbox-start:${stepId}`, status: 'completed', source: agent.name });
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
    const guidance = [
      `You are "${agent.name}"${agent.description !== '' ? ` — ${agent.description}` : ''}.`,
      agent.instructions,
      `You have an isolated sandbox computer, available through the "${SANDBOX_MCP_KEY}" MCP server (${groups.join(', ')}).`
      + ' Do ALL of your work there: browse the web with its browser tools, run commands with its terminal, and handle files in its file tools.'
      + ' Your own shell, web search, web fetch and file-editing tools are disabled for this agent, so do not try them (no curl, no local web search).'
      + `${approvals}`,
    ].filter((line) => line.trim() !== '').join('\n\n');
    return { server: { key: SANDBOX_MCP_KEY, url: session.url }, guidance };
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
