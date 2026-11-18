import { randomUUID } from 'node:crypto';
import type { Task } from '@shared/domain';
import { DEFAULT_REPLY_HOURS, flowProblem, type AgentFlow, type FlowEdge, type FlowInput, type FlowNode, type FlowNodeStatus, type FlowRun, type FlowSchedule } from '@shared/agent-flows';
import type { Store } from '../db/types';
import { nextCronRun } from './cron';
import type { TaskCreator, ReplyReader } from './sandbox-agents';
import { draftPrompt, parseDraft } from './flow-draft';
import type { AgentMail, MailMessage } from './agentmail';

const SETTLED = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED', 'RECOVERABLE_INTERRUPTION']);
const MAX_HANDOFF = 6_000;
const MAX_OUTPUT = 20_000;
const TICK_MS = 30_000;
/** Sandbox keys starting with `group-` use the shared workspace volume. */
const FLOW_SANDBOX_PREFIX = 'group-flow-';

interface FlowRow { id: string; name: string; input: string; nodes: string; edges: string; schedule: string | null; next_run_at: string | null; last_run_at: string | null; created_at: string; updated_at: string }
interface RunRow { id: string; flow_id: string; trigger: 'manual' | 'schedule'; status: FlowRun['status']; input: string; definition: string; started_at: string; finished_at: string | null }
interface NodeRow { run_id: string; node_id: string; status: FlowNodeStatus; task_id: string | null; output: string; note: string; started_at: string | null }
interface Definition { name: string; nodes: FlowNode[]; edges: FlowEdge[] }

export interface FlowServiceDeps {
  store: Store;
  /** The sandbox agents a flow's steps run as. */
  agents: {
    get(id: string): { id: string; name: string } | undefined;
    list(): Array<{ id: string; name: string; description: string }>;
    startingCli(agentId: string, preferred?: string, anyCli?: boolean): string;
    bindThread(threadId: string, agentId: string): void;
  };
  /** The hidden workspace agent chats use. */
  workspaceId: () => string;
  /** The email inbox reply steps wait on. */
  mail?: AgentMail;
  now?: () => Date;
}

const parse = <T>(text: string, fallback: T): T => { try { return JSON.parse(text) as T; } catch { return fallback; } };

/** Flows of agent steps: saved on a canvas, run by hand or on a cron schedule. */
export class AgentFlowService {
  private createTask: TaskCreator | undefined;
  private readReply: ReplyReader | undefined;
  private canceller: ((taskId: string) => Promise<unknown>) | undefined;
  private planner: ((prompt: string) => Promise<string | undefined>) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopMail: (() => void) | undefined;

  constructor(private readonly deps: FlowServiceDeps) {}

  setTaskCreator(create: TaskCreator): void { this.createTask = create; }
  setReplyReader(read: ReplyReader): void { this.readReply = read; }
  setTaskCanceller(cancel: (taskId: string) => Promise<unknown>): void { this.canceller = cancel; }
  setPlanner(ask: (prompt: string) => Promise<string | undefined>): void { this.planner = ask; }

  /** A flow drafted from a description, not saved. */
  async draft(description: string): Promise<Omit<FlowInput, 'id'>> {
    const agents = this.deps.agents.list();
    if (agents.length === 0) throw new Error('Create at least one agent first; a flow is made of their steps.');
    if (this.planner === undefined) throw new Error('Conductor is still starting.');
    const mail = this.deps.mail?.status().configured === true;
    const reply = await this.planner(draftPrompt(description, agents, mail));
    if (reply === undefined || reply.trim() === '') throw new Error('No agent CLI answered. Sign in to one in Settings and try again.');
    const drafted = parseDraft(reply, agents, mail);
    if ('error' in drafted) throw new Error(drafted.error);
    return drafted.flow;
  }

  private now(): Date { return (this.deps.now ?? (() => new Date()))(); }
  private get db() { return this.deps.store.db; }

  // ---- flows ----------------------------------------------------------------

  private toFlow(row: FlowRow): AgentFlow {
    return {
      id: row.id, name: row.name, input: row.input, nodes: parse<FlowNode[]>(row.nodes, []), edges: parse<FlowEdge[]>(row.edges, []),
      schedule: row.schedule === null ? null : parse<FlowSchedule | null>(row.schedule, null),
      nextRunAt: row.next_run_at, lastRunAt: row.last_run_at, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  list(): AgentFlow[] {
    return (this.db.prepare('SELECT * FROM agent_flows ORDER BY updated_at DESC').all() as FlowRow[]).map((row) => this.toFlow(row));
  }

  get(id: string): AgentFlow | undefined {
    const row = this.db.prepare('SELECT * FROM agent_flows WHERE id = ?').get(id) as FlowRow | undefined;
    return row === undefined ? undefined : this.toFlow(row);
  }

  save(input: FlowInput): AgentFlow {
    const problem = flowProblem(input.nodes, input.edges);
    if (problem !== undefined) throw new Error(problem);
    for (const node of input.nodes) if (node.kind !== 'reply' && this.deps.agents.get(node.agentId) === undefined) throw new Error('A step uses an agent that no longer exists.');
    let next: string | null = null;
    if (input.schedule !== null) {
      const at = nextCronRun(input.schedule.cron, this.now());
      if (at === undefined) throw new Error('That schedule is not a valid cron expression (minute hour day month weekday).');
      next = input.schedule.enabled ? at.toISOString() : null;
    }
    const now = this.now().toISOString();
    const id = input.id ?? randomUUID();
    const fields = [input.name, input.input, JSON.stringify(input.nodes), JSON.stringify(input.edges), input.schedule === null ? null : JSON.stringify(input.schedule), next];
    if (input.id !== undefined && this.get(input.id) !== undefined) {
      this.db.prepare('UPDATE agent_flows SET name=?, input=?, nodes=?, edges=?, schedule=?, next_run_at=?, updated_at=? WHERE id=?').run(...fields, now, id);
    } else {
      this.db.prepare('INSERT INTO agent_flows (id, name, input, nodes, edges, schedule, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, ...fields, now, now);
    }
    return this.get(id)!;
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM agent_flows WHERE id = ?').run(id);
  }

  // ---- scheduling -----------------------------------------------------------

  /** Check for due flows now and every half minute. A flow overdue after the app was closed runs once. */
  start(): void {
    if (this.timer !== undefined) return;
    this.stopMail = this.deps.mail?.onMessage((message) => { void this.mailArrived(message).catch(() => undefined); });
    this.deps.mail?.listen();
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.stopMail?.();
    this.stopMail = undefined;
    this.deps.mail?.stop();
  }

  async tick(): Promise<void> {
    await this.checkReplies().catch(() => undefined);
    const now = this.now();
    const due = this.db.prepare('SELECT id FROM agent_flows WHERE next_run_at IS NOT NULL AND next_run_at <= ?').all(now.toISOString()) as Array<{ id: string }>;
    for (const { id } of due) {
      const flow = this.get(id);
      if (flow === undefined) continue;
      const at = flow.schedule?.enabled === true ? nextCronRun(flow.schedule.cron, now) : undefined;
      this.db.prepare('UPDATE agent_flows SET next_run_at = ? WHERE id = ?').run(at?.toISOString() ?? null, id);
      // One run at a time: a run that is still going swallows this firing.
      if (this.db.prepare("SELECT 1 FROM agent_flow_runs WHERE flow_id = ? AND status = 'running'").get(id) !== undefined) continue;
      await this.run(id, 'schedule').catch(() => undefined);
    }
  }

  /** The steps of one flow share one sandbox, so files (resumes, lists) carry from step to step and only one sandbox's memory is used. */
  sandboxScopeFor(taskId: string): { key: string; name: string; label: string } | undefined {
    const row = this.db.prepare(`SELECT r.flow_id AS id, r.definition FROM agent_flow_run_nodes n JOIN agent_flow_runs r ON r.id = n.run_id WHERE n.task_id = ?`).get(taskId) as { id: string; definition: string } | undefined;
    if (row === undefined) return undefined;
    return { key: `${FLOW_SANDBOX_PREFIX}${row.id}`, name: parse<Definition>(row.definition, { name: 'Workflow', nodes: [], edges: [] }).name, label: 'workflow' };
  }

  /** The agent a flow step's task runs as (steps are not part of the agent's own chats). */
  agentIdForTask(taskId: string): string | undefined {
    const row = this.db.prepare('SELECT n.node_id, r.definition FROM agent_flow_run_nodes n JOIN agent_flow_runs r ON r.id = n.run_id WHERE n.task_id = ?').get(taskId) as { node_id: string; definition: string } | undefined;
    if (row === undefined) return undefined;
    const agentId = parse<Definition>(row.definition, { name: '', nodes: [], edges: [] }).nodes.find((node) => node.id === row.node_id)?.agentId;
    return agentId === undefined || agentId === '' ? undefined : agentId;
  }

  /** Stop a run: cancel the steps that are working, skip the ones still waiting. */
  async stopRun(runId: string): Promise<FlowRun> {
    const run = this.db.prepare('SELECT status FROM agent_flow_runs WHERE id = ?').get(runId) as { status: string } | undefined;
    if (run === undefined) throw new Error('That run no longer exists.');
    if (run.status !== 'running') return this.runById(runId)!;
    const working = this.db.prepare("SELECT task_id FROM agent_flow_run_nodes WHERE run_id = ? AND status = 'running' AND task_id IS NOT NULL").all(runId) as Array<{ task_id: string }>;
    this.db.prepare("UPDATE agent_flow_run_nodes SET status = 'failed', note = 'Stopped by you.' WHERE run_id = ? AND status = 'running'").run(runId);
    this.db.prepare("UPDATE agent_flow_run_nodes SET status = 'skipped', note = 'The run was stopped before this step.' WHERE run_id = ? AND status = 'waiting'").run(runId);
    this.db.prepare("UPDATE agent_flow_runs SET status = 'failed', finished_at = ? WHERE id = ?").run(this.now().toISOString(), runId);
    for (const { task_id } of working) await this.canceller?.(task_id).catch(() => undefined);
    return this.runById(runId)!;
  }

  /** Recent runs of every flow, newest first, with the flow's name. */
  history(limit = 50): Array<FlowRun & { flowName: string; labels: Record<string, string> }> {
    const rows = this.db.prepare('SELECT r.id, r.definition, r.input FROM agent_flow_runs r ORDER BY r.started_at DESC LIMIT ?').all(limit) as Array<{ id: string; definition: string; input: string }>;
    return rows.flatMap((row) => {
      const run = this.runById(row.id);
      if (run === undefined) return [];
      const definition = parse<Definition>(row.definition, { name: 'Flow', nodes: [], edges: [] });
      const labels = Object.fromEntries(definition.nodes.map((node) => [node.id, node.kind === 'reply' ? 'Wait for your email reply' : this.deps.agents.get(node.agentId)?.name ?? 'Agent']));
      const order = new Map(definition.nodes.map((node, index) => [node.id, index]));
      return [{ ...run, nodes: [...run.nodes].sort((a, b) => (order.get(a.nodeId) ?? 0) - (order.get(b.nodeId) ?? 0)), flowName: definition.name, labels }];
    });
  }

  // ---- runs -----------------------------------------------------------------

  /** Start a run. Resolves once the first steps are started. */
  async run(flowId: string, trigger: 'manual' | 'schedule', input?: string): Promise<FlowRun> {
    const flow = this.get(flowId);
    if (flow === undefined) throw new Error('That flow no longer exists.');
    const problem = flowProblem(flow.nodes, flow.edges);
    if (problem !== undefined) throw new Error(problem);
    const runId = randomUUID();
    const now = this.now().toISOString();
    const definition: Definition = { name: flow.name, nodes: flow.nodes, edges: flow.edges };
    this.deps.store.transaction(({ db }) => {
      db.prepare("INSERT INTO agent_flow_runs (id, flow_id, trigger, status, input, definition, started_at) VALUES (?, ?, ?, 'running', ?, ?, ?)")
        .run(runId, flowId, trigger, input ?? flow.input, JSON.stringify(definition), now);
      for (const node of flow.nodes) db.prepare("INSERT INTO agent_flow_run_nodes (run_id, node_id, status) VALUES (?, ?, 'waiting')").run(runId, node.id);
      db.prepare('UPDATE agent_flows SET last_run_at = ? WHERE id = ?').run(now, flowId);
    });
    await this.advance(runId);
    return this.runById(runId)!;
  }

  private runById(runId: string): FlowRun | undefined {
    const row = this.db.prepare('SELECT * FROM agent_flow_runs WHERE id = ?').get(runId) as RunRow | undefined;
    if (row === undefined) return undefined;
    const nodes = (this.db.prepare('SELECT * FROM agent_flow_run_nodes WHERE run_id = ?').all(runId) as NodeRow[])
      .map((node) => ({ nodeId: node.node_id, status: node.status, taskId: node.task_id, output: node.output, note: node.note }));
    return { id: row.id, flowId: row.flow_id, trigger: row.trigger, status: row.status, input: row.input, startedAt: row.started_at, finishedAt: row.finished_at, nodes };
  }

  /** The most recent runs of a flow, newest first. */
  runs(flowId: string, limit = 10): FlowRun[] {
    const ids = this.db.prepare('SELECT id FROM agent_flow_runs WHERE flow_id = ? ORDER BY started_at DESC LIMIT ?').all(flowId, limit) as Array<{ id: string }>;
    return ids.map(({ id }) => this.runById(id)).filter((run): run is FlowRun => run !== undefined);
  }

  /** Start every step whose predecessors are done; skip those behind a failure; close the run when nothing is left. */
  private async advance(runId: string): Promise<void> {
    for (let guard = 0; guard < 100; guard += 1) {
      const run = this.db.prepare('SELECT * FROM agent_flow_runs WHERE id = ?').get(runId) as RunRow | undefined;
      if (run === undefined || run.status !== 'running') return;
      const definition = parse<Definition>(run.definition, { name: '', nodes: [], edges: [] });
      const states = new Map((this.db.prepare('SELECT * FROM agent_flow_run_nodes WHERE run_id = ?').all(runId) as NodeRow[]).map((node) => [node.node_id, node]));
      let changed = false;
      for (const node of definition.nodes) {
        if (states.get(node.id)?.status !== 'waiting') continue;
        const before = definition.edges.filter((edge) => edge.to === node.id).map((edge) => states.get(edge.from)?.status);
        if (before.some((status) => status === 'failed' || status === 'skipped')) {
          this.db.prepare("UPDATE agent_flow_run_nodes SET status = 'skipped', note = ? WHERE run_id = ? AND node_id = ?").run('A step before this one did not finish.', runId, node.id);
          changed = true;
        } else if (before.every((status) => status === 'done')) {
          changed = true;
          if (node.kind === 'reply') {
            // Waiting only makes sense if the step before really emailed the user.
            const sources = definition.edges.filter((edge) => edge.to === node.id).map((edge) => states.get(edge.from)?.task_id).filter((id): id is string => typeof id === 'string');
            const mail = this.deps.mail;
            if (mail === undefined || !mail.status().configured) { this.db.prepare("UPDATE agent_flow_run_nodes SET status = 'failed', note = ? WHERE run_id = ? AND node_id = ?").run('Email is not connected, so there is nothing to wait for.', runId, node.id); continue; }
            if (mail.threadsFor(sources).length === 0) { this.db.prepare("UPDATE agent_flow_run_nodes SET status = 'failed', note = ? WHERE run_id = ? AND node_id = ?").run('The step before this one never sent you an email, so there is no reply to wait for.', runId, node.id); continue; }
          }
          this.db.prepare("UPDATE agent_flow_run_nodes SET status = 'running', started_at = ? WHERE run_id = ? AND node_id = ?").run(this.now().toISOString(), runId, node.id);
          if (node.kind === 'reply') this.db.prepare('UPDATE agent_flow_run_nodes SET note = ? WHERE run_id = ? AND node_id = ?').run('Waiting for your reply by email.', runId, node.id);
          else await this.startNode(run, definition, node, states);
        }
      }
      if (changed) continue;
      const all = [...states.values()];
      if (all.some((node) => node.status === 'waiting' || node.status === 'running')) return;
      this.db.prepare('UPDATE agent_flow_runs SET status = ?, finished_at = ? WHERE id = ?')
        .run(all.every((node) => node.status === 'done') ? 'done' : 'failed', this.now().toISOString(), runId);
      return;
    }
  }

  private async startNode(run: RunRow, definition: Definition, node: FlowNode, states: Map<string, NodeRow>): Promise<void> {
    const fail = (note: string): void => { this.db.prepare("UPDATE agent_flow_run_nodes SET status = 'failed', note = ? WHERE run_id = ? AND node_id = ?").run(note, run.id, node.id); };
    const agent = this.deps.agents.get(node.agentId);
    if (agent === undefined) { fail('This agent no longer exists.'); return; }
    if (this.createTask === undefined) { fail('Conductor is still starting.'); return; }
    const built = definition.edges.filter((edge) => edge.to === node.id).flatMap((edge) => {
      const source = definition.nodes.find((item) => item.id === edge.from);
      const done = states.get(edge.from);
      if (source === undefined || done === undefined) return [];
      const who = source.kind === 'reply' ? 'The user replied by email' : this.deps.agents.get(source.agentId)?.name ?? 'An earlier step';
      return [`${who} finished and said:\n${done.output.trim() === '' ? '(no written answer; look at the files it saved)' : done.output.slice(0, MAX_HANDOFF)}`];
    });
    const task = node.prompt.replace(/\{\{\s*input\s*\}\}/g, run.input).trim();
    const objective = [
      `[Workflow “${definition.name}” — you are ${agent.name}. Do your step; the steps after yours build on what you leave.]`,
      run.input.trim() !== '' && !/\{\{\s*input\s*\}\}/.test(node.prompt) ? `Workflow input:\n${run.input}` : '',
      built.length > 0 ? `Work you build on:\n${built.join('\n\n')}` : '',
      task !== '' ? `Your step:\n${task}` : 'Your step: continue the workflow with what you were given.',
    ].filter((part) => part !== '').join('\n\n');
    try {
      // A step may name any installed CLI; otherwise the agent's first available one runs it.
      const cli = this.deps.agents.startingCli(node.agentId, node.cli, true);
      await this.createTask({
        workspaceId: this.deps.workspaceId(),
        objective,
        agentId: cli,
        ...(node.model !== undefined || node.effort !== undefined ? { runOptions: { main: { ...(node.model !== undefined ? { model: node.model } : {}), ...(node.effort !== undefined ? { effort: node.effort } : {}) }, mainAgentId: cli } } : {}),
        onCreated: (created) => {
          // Not bound to the agent's chat: a flow's steps are shown in the flow's history instead.
          this.db.prepare('UPDATE agent_flow_run_nodes SET task_id = ? WHERE run_id = ? AND node_id = ?').run(created.id, run.id, node.id);
        },
      });
    } catch (error) {
      fail(`${agent.name}: ${error instanceof Error ? error.message : 'could not start'}`);
    }
  }

  /** A step's task ended: record what it said, then go on with the steps waiting on it. */
  async taskSettled(task: Pick<Task, 'id' | 'state'>): Promise<void> {
    if (!SETTLED.has(task.state)) return;
    const node = this.db.prepare("SELECT run_id, node_id FROM agent_flow_run_nodes WHERE task_id = ? AND status = 'running'").get(task.id) as { run_id: string; node_id: string } | undefined;
    if (node === undefined) return;
    const done = task.state === 'COMPLETED';
    const output = done ? (this.readReply?.(task.id) ?? '').slice(0, MAX_OUTPUT) : '';
    this.db.prepare('UPDATE agent_flow_run_nodes SET status = ?, output = ?, note = ? WHERE run_id = ? AND node_id = ?')
      .run(done ? 'done' : 'failed', output, done ? '' : `The run ended (${task.state.toLowerCase().replace(/_/g, ' ')}).`, node.run_id, node.node_id);
    await this.advance(node.run_id);
  }

  // ---- reply steps ----------------------------------------------------------

  /** Reply steps still waiting, with what is needed to match an answer to them. */
  private waitingReplies(): Array<{ runId: string; nodeId: string; startedAt: string; upstreamTasks: string[]; waitHours: number }> {
    const rows = this.db.prepare(`SELECT n.run_id, n.node_id, n.started_at, r.definition FROM agent_flow_run_nodes n JOIN agent_flow_runs r ON r.id = n.run_id
      WHERE n.status = 'running' AND n.task_id IS NULL AND r.status = 'running'`).all() as Array<{ run_id: string; node_id: string; started_at: string | null; definition: string }>;
    const out: ReturnType<AgentFlowService['waitingReplies']> = [];
    for (const row of rows) {
      const definition = parse<Definition>(row.definition, { name: '', nodes: [], edges: [] });
      const node = definition.nodes.find((item) => item.id === row.node_id);
      if (node?.kind !== 'reply') continue;
      const before = definition.edges.filter((edge) => edge.to === node.id).map((edge) => edge.from);
      const tasks = (this.db.prepare('SELECT node_id, task_id FROM agent_flow_run_nodes WHERE run_id = ?').all(row.run_id) as Array<{ node_id: string; task_id: string | null }>)
        .filter((item) => before.includes(item.node_id) && item.task_id !== null).map((item) => item.task_id as string);
      out.push({ runId: row.run_id, nodeId: row.node_id, startedAt: row.started_at ?? '', upstreamTasks: tasks, waitHours: node.waitHours ?? DEFAULT_REPLY_HOURS });
    }
    return out;
  }

  /** The user wrote to the inbox: it answers the waiting step whose email started that thread (or, if none is known, the oldest waiting). */
  async mailArrived(message: MailMessage): Promise<void> {
    const mail = this.deps.mail;
    if (mail === undefined || !mail.isOwner(message)) return;
    const waiting = this.waitingReplies().filter((item) => item.startedAt <= (message.at || '9999'));
    const sorted = waiting.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const byThread = sorted.find((item) => mail.threadsFor(item.upstreamTasks).includes(message.threadId));
    const target = byThread ?? sorted.find((item) => mail.threadsFor(item.upstreamTasks).length === 0);
    if (target === undefined) return;
    this.db.prepare("UPDATE agent_flow_run_nodes SET status = 'done', output = ?, note = '' WHERE run_id = ? AND node_id = ? AND status = 'running'")
      .run(`Subject: ${message.subject}\n${message.text}`.slice(0, MAX_OUTPUT), target.runId, target.nodeId);
    await this.advance(target.runId);
  }

  /** Give up on replies that never came, and pick up replies that arrived while the app was closed or offline. */
  private async checkReplies(): Promise<void> {
    const waiting = this.waitingReplies();
    if (waiting.length === 0) return;
    const now = this.now().getTime();
    for (const item of waiting) {
      if (item.startedAt !== '' && now - new Date(item.startedAt).getTime() > item.waitHours * 3_600_000) {
        this.db.prepare("UPDATE agent_flow_run_nodes SET status = 'failed', note = ? WHERE run_id = ? AND node_id = ? AND status = 'running'").run(`No reply came within ${item.waitHours} hours.`, item.runId, item.nodeId);
        await this.advance(item.runId);
      }
    }
    const mail = this.deps.mail;
    if (mail === undefined || !mail.status().configured) return;
    const since = waiting.map((item) => item.startedAt).filter((value) => value !== '').sort()[0];
    if (since === undefined) return;
    for (const message of await mail.repliesSince(since)) await this.mailArrived(message);
  }

  /** After a restart: settle steps whose task ended meanwhile, fail ones that never got a task. */
  async reconcile(): Promise<void> {
    this.db.prepare(`UPDATE agent_flow_run_nodes SET status = 'failed', note = 'The app closed before this step started.'
      WHERE status = 'running' AND task_id IS NULL AND note NOT LIKE 'Waiting for your reply%' AND run_id IN (SELECT id FROM agent_flow_runs WHERE status = 'running')`).run();
    const rows = this.db.prepare(`SELECT n.task_id AS id, t.state FROM agent_flow_run_nodes n JOIN tasks t ON t.id = n.task_id WHERE n.status = 'running'`).all() as Array<{ id: string; state: string }>;
    for (const row of rows) await this.taskSettled({ id: row.id, state: row.state as Task['state'] });
    const open = this.db.prepare("SELECT id FROM agent_flow_runs WHERE status = 'running'").all() as Array<{ id: string }>;
    for (const { id } of open) await this.advance(id);
  }
}
