import { randomUUID } from 'node:crypto';
import type { Task } from '@shared/domain';
import { flowProblem, type AgentFlow, type FlowEdge, type FlowInput, type FlowNode, type FlowNodeStatus, type FlowRun, type FlowSchedule } from '@shared/agent-flows';
import type { Store } from '../db/types';
import { nextCronRun } from './cron';
import type { TaskCreator, ReplyReader } from './sandbox-agents';

const SETTLED = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED', 'RECOVERABLE_INTERRUPTION']);
const MAX_HANDOFF = 6_000;
const MAX_OUTPUT = 20_000;
const TICK_MS = 30_000;

interface FlowRow { id: string; name: string; input: string; nodes: string; edges: string; schedule: string | null; next_run_at: string | null; last_run_at: string | null; created_at: string; updated_at: string }
interface RunRow { id: string; flow_id: string; trigger: 'manual' | 'schedule'; status: FlowRun['status']; input: string; definition: string; started_at: string; finished_at: string | null }
interface NodeRow { run_id: string; node_id: string; status: FlowNodeStatus; task_id: string | null; output: string; note: string }
interface Definition { name: string; nodes: FlowNode[]; edges: FlowEdge[] }

export interface FlowServiceDeps {
  store: Store;
  /** The sandbox agents a flow's steps run as. */
  agents: {
    get(id: string): { id: string; name: string } | undefined;
    startingCli(agentId: string): string;
    bindThread(threadId: string, agentId: string): void;
  };
  /** The hidden workspace agent chats use. */
  workspaceId: () => string;
  now?: () => Date;
}

const parse = <T>(text: string, fallback: T): T => { try { return JSON.parse(text) as T; } catch { return fallback; } };

/** Flows of agent steps: saved on a canvas, run by hand or on a cron schedule. */
export class AgentFlowService {
  private createTask: TaskCreator | undefined;
  private readReply: ReplyReader | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: FlowServiceDeps) {}

  setTaskCreator(create: TaskCreator): void { this.createTask = create; }
  setReplyReader(read: ReplyReader): void { this.readReply = read; }

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
    for (const node of input.nodes) if (this.deps.agents.get(node.agentId) === undefined) throw new Error('A step uses an agent that no longer exists.');
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
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
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
    return { id: row.id, flowId: row.flow_id, trigger: row.trigger, status: row.status, startedAt: row.started_at, finishedAt: row.finished_at, nodes };
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
          this.db.prepare("UPDATE agent_flow_run_nodes SET status = 'running' WHERE run_id = ? AND node_id = ?").run(runId, node.id);
          changed = true;
          await this.startNode(run, definition, node, states);
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
      const who = this.deps.agents.get(source.agentId)?.name ?? 'An earlier step';
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
      await this.createTask({
        workspaceId: this.deps.workspaceId(),
        objective,
        agentId: this.deps.agents.startingCli(node.agentId),
        onCreated: (created) => {
          this.deps.agents.bindThread(created.threadId ?? created.id, node.agentId);
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

  /** After a restart: settle steps whose task ended meanwhile, fail ones that never got a task. */
  async reconcile(): Promise<void> {
    this.db.prepare(`UPDATE agent_flow_run_nodes SET status = 'failed', note = 'The app closed before this step started.'
      WHERE status = 'running' AND task_id IS NULL AND run_id IN (SELECT id FROM agent_flow_runs WHERE status = 'running')`).run();
    const rows = this.db.prepare(`SELECT n.task_id AS id, t.state FROM agent_flow_run_nodes n JOIN tasks t ON t.id = n.task_id WHERE n.status = 'running'`).all() as Array<{ id: string; state: string }>;
    for (const row of rows) await this.taskSettled({ id: row.id, state: row.state as Task['state'] });
    const open = this.db.prepare("SELECT id FROM agent_flow_runs WHERE status = 'running'").all() as Array<{ id: string }>;
    for (const { id } of open) await this.advance(id);
  }
}
