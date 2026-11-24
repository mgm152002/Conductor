import { randomUUID } from 'node:crypto';
import type { Task } from '@shared/domain';
import { DEFAULT_MAX_ROUNDS, DEFAULT_REPLY_HOURS, flowProblem, type AgentFlow, type FlowEdge, type FlowExecutionNode, type FlowInput, type FlowNode, type FlowNodeStatus, type FlowRun, type FlowSchedule, type ReviewVerdict } from '@shared/agent-flows';
import type { Store } from '../db/types';
import { nextCronRun } from './cron';
import type { TaskCreator, ReplyReader } from './sandbox-agents';
import { draftPrompt, parseDraft } from './flow-draft';
import { applyFeedbackDecision, feedbackPrompt, parseFeedbackDecision } from './flow-feedback';
import type { AgentMail, MailMessage } from './agentmail';

const SETTLED = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED', 'RECOVERABLE_INTERRUPTION']);
const MAX_HANDOFF = 6_000;
const MAX_OUTPUT = 20_000;
const TICK_MS = 30_000;
/** Sandbox keys starting with `group-` use the shared workspace volume. */
const FLOW_SANDBOX_PREFIX = 'group-flow-';
/** The sandbox every step of a flow shares. */
export const flowSandboxKey = (flowId: string): string => `${FLOW_SANDBOX_PREFIX}${flowId}`;

interface FlowRow { id: string; name: string; input: string; nodes: string; edges: string; schedule: string | null; next_run_at: string | null; last_run_at: string | null; created_at: string; updated_at: string }
interface RunRow { id: string; flow_id: string; trigger: 'manual' | 'schedule'; status: FlowRun['status']; input: string; definition: string; started_at: string; finished_at: string | null }
interface NodeRow { run_id: string; node_id: string; status: FlowNodeStatus; task_id: string | null; output: string; note: string; started_at: string | null; rounds: number; branch: string | null; pending_input: string | null }
interface Definition { name: string; nodes: FlowExecutionNode[]; edges: FlowEdge[]; feedbackMessages?: string[] }

/** Reply and review steps both pause the flow on an email from the user. */
const isWaitKind = (kind: FlowExecutionNode['kind']): kind is 'reply' | 'review' => kind === 'reply' || kind === 'review';

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

/** The label of the first arrow out of `nodeId` whose condition the reply text matches, or null when none fires. */
function matchBranch(definition: Definition, nodeId: string, text: string): string | null {
  for (const edge of definition.edges) {
    if (edge.from !== nodeId || edge.when?.match === undefined || edge.when.match.trim() === '') continue;
    try { if (new RegExp(edge.when.match, 'i').test(text)) return edge.when.label; } catch { /* an invalid pattern is refused when the flow is saved */ }
  }
  return null;
}

// Heuristic verdicts when a review flow brings no conditions of its own.
// Explicit "no changes" phrasing is checked before change-request words so
// "no changes needed" does not read as a request for changes; anything still
// ambiguous goes back for another pass, which maxRounds bounds anyway. A
// flow's own branch conditions always decide first.
const CLEAR_APPROVE = /\b(no changes|nothing to (?:change|fix|edit)|all (?:good|clear|fine)|looks perfect|perfect|great work|good to (?:go|merge)|ready to (?:ship|publish|merge))\b/i;
const CHANGE_WORDS = /\b(revise|rework|redo|fix(?:es|ed)?|changes?|not (?:yet )?approved|doesn'?t work|wrong|too (?:long|short|wordy)|again|try again|nope|reject(?:ed)?|disagree|improve|tighten|shorten|expand)\b/i;
const APPROVE_WORDS = /\b(approv(?:e|ed|al)|looks good|lgtm|ship it|go ahead|accepted|yes|yep|ok(?:ay)?|fine|great|send it)\b/i;

/** The verdict a review step's reply settles on: the flow's conditions first, then the phrasing heuristics. */
function classifyReview(definition: Definition, node: FlowExecutionNode, text: string): ReviewVerdict {
  const conditioned = matchBranch(definition, node.id, text);
  if (conditioned !== null) return conditioned === 'approve' ? 'approve' : 'revise';
  if (CLEAR_APPROVE.test(text)) return 'approve';
  if (CHANGE_WORDS.test(text)) return 'revise';
  return APPROVE_WORDS.test(text) ? 'approve' : 'revise';
}

/** Flows of agent steps: saved on a canvas, run by hand or on a cron schedule. */
export class AgentFlowService {
  private createTask: TaskCreator | undefined;
  private readReply: ReplyReader | undefined;
  private canceller: ((taskId: string) => Promise<unknown>) | undefined;
  private planner: ((prompt: string) => Promise<string | undefined>) | undefined;
  private feedbackRouter: ((input: { prompt: string; cli: string; model?: string; effort?: string }) => Promise<string | undefined>) | undefined;
  private readonly routing = new Set<string>();
  private readonly runLocks = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopMail: (() => void) | undefined;

  constructor(private readonly deps: FlowServiceDeps) {}

  setTaskCreator(create: TaskCreator): void { this.createTask = create; }
  setReplyReader(read: ReplyReader): void { this.readReply = read; }
  setTaskCanceller(cancel: (taskId: string) => Promise<unknown>): void { this.canceller = cancel; }
  setPlanner(ask: (prompt: string) => Promise<string | undefined>): void { this.planner = ask; }

  setFeedbackRouter(route: NonNullable<AgentFlowService['feedbackRouter']>): void { this.feedbackRouter = route; }

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
    for (const node of input.nodes) if (!isWaitKind(node.kind) && this.deps.agents.get(node.agentId) === undefined) throw new Error('A step uses an agent that no longer exists.');
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
    return { key: flowSandboxKey(row.id), name: parse<Definition>(row.definition, { name: 'Workflow', nodes: [], edges: [] }).name, label: 'workflow' };
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
      const labels = Object.fromEntries(definition.nodes.map((node) => [node.id, node.kind === 'reply' ? 'Wait for your email reply' : node.kind === 'review' ? 'Review: approve or send back' : node.kind === 'rewind' ? 'Rewind with feedback' : this.deps.agents.get(node.agentId)?.name ?? 'Agent']));
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
      .map((node) => ({
        nodeId: node.node_id, status: node.status, taskId: node.task_id, output: node.output, note: node.note,
        ...(node.rounds > 0 ? { rounds: node.rounds } : {}), ...(node.branch !== null ? { branch: node.branch } : {}),
      }));
    return { id: row.id, flowId: row.flow_id, trigger: row.trigger, status: row.status, input: row.input, startedAt: row.started_at, finishedAt: row.finished_at, nodes };
  }

  /** The most recent runs of a flow, newest first. */
  runs(flowId: string, limit = 10): FlowRun[] {
    const ids = this.db.prepare('SELECT id FROM agent_flow_runs WHERE flow_id = ? ORDER BY started_at DESC LIMIT ?').all(flowId, limit) as Array<{ id: string }>;
    return ids.map(({ id }) => this.runById(id)).filter((run): run is FlowRun => run !== undefined);
  }

  /** Start every step whose predecessors are done; skip those behind a failure; close the run when nothing is left. */
  private async withRunLock<T>(runId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.runLocks.get(runId) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => gate);
    this.runLocks.set(runId, queued);
    await previous;
    try { return await action(); }
    finally {
      release();
      if (this.runLocks.get(runId) === queued) this.runLocks.delete(runId);
    }
  }

  private async advance(runId: string): Promise<void> {
    await this.withRunLock(runId, () => this.advanceUnlocked(runId));
  }

  private async advanceUnlocked(runId: string): Promise<void> {
    for (let guard = 0; guard < 100; guard += 1) {
      const run = this.db.prepare('SELECT * FROM agent_flow_runs WHERE id = ?').get(runId) as RunRow | undefined;
      if (run === undefined || run.status !== 'running') return;
      const definition = parse<Definition>(run.definition, { name: '', nodes: [], edges: [] });
      const states = new Map((this.db.prepare('SELECT * FROM agent_flow_run_nodes WHERE run_id = ?').all(runId) as NodeRow[]).map((node) => [node.node_id, node]));
      let changed = false;
      for (const node of definition.nodes) {
        if (states.get(node.id)?.status !== 'waiting') continue;
        const incoming = definition.edges.filter((edge) => edge.to === node.id);
        // An arrow whose branch condition didn't fire is absent from the
        // readiness check: a step waits only on the branches that actually led
        // to it. An arrow from a step that has not settled yet still counts —
        // its branch is not known, so nothing may start behind it.
        const fired = incoming.filter((edge) => {
          const source = states.get(edge.from);
          if (source?.status === 'skipped' && source.note === 'No branch led here.') return false;
          return edge.when === undefined || source?.branch === edge.when.label;
        });
        const unfired = incoming.filter((edge) => !fired.includes(edge));
        const before = fired.map((edge) => states.get(edge.from)?.status);
        const unsettled = [...before, ...unfired.map((edge) => states.get(edge.from)?.status)]
          .some((status) => status === 'waiting' || status === 'running');
        const failed = before
          .some((status) => status === 'failed' || status === 'skipped');
        if (failed) {
          this.db.prepare("UPDATE agent_flow_run_nodes SET status = 'skipped', note = ? WHERE run_id = ? AND node_id = ?").run('A step before this one did not finish.', runId, node.id);
          changed = true;
        } else if (unsettled) {
          // Still waiting on something ahead; nothing to do this pass.
        } else if (incoming.length === 0 || (before.length > 0 && before.every((status) => status === 'done'))) {
          changed = true;
          if (node.kind === 'rewind') {
            this.db.prepare("UPDATE agent_flow_run_nodes SET status = 'done', output = ?, note = 'Feedback routed to a new revision.' WHERE run_id = ? AND node_id = ?").run(node.prompt, runId, node.id);
            continue;
          }
          if (isWaitKind(node.kind)) {
            // Waiting only makes sense if the step before really emailed the user.
            const sources = incoming.map((edge) => states.get(edge.from)?.task_id).filter((id): id is string => typeof id === 'string');
            const mail = this.deps.mail;
            if (mail === undefined || !mail.status().configured) { this.db.prepare("UPDATE agent_flow_run_nodes SET status = 'failed', note = ? WHERE run_id = ? AND node_id = ?").run('Email is not connected, so there is nothing to wait for.', runId, node.id); continue; }
            if (mail.threadsFor(sources).length === 0) { this.db.prepare("UPDATE agent_flow_run_nodes SET status = 'failed', note = ? WHERE run_id = ? AND node_id = ?").run('The step before this one never sent you an email, so there is no reply to wait for.', runId, node.id); continue; }
          }
          this.db.prepare("UPDATE agent_flow_run_nodes SET status = 'running', started_at = ? WHERE run_id = ? AND node_id = ?").run(this.now().toISOString(), runId, node.id);
          if (isWaitKind(node.kind)) this.db.prepare('UPDATE agent_flow_run_nodes SET note = ? WHERE run_id = ? AND node_id = ?').run('Waiting for your reply by email.', runId, node.id);
          else await this.startNode(run, definition, node, states);
        } else if (before.length === 0) {
          // Everything ahead settled and no branch led here.
          this.db.prepare("UPDATE agent_flow_run_nodes SET status = 'skipped', note = ? WHERE run_id = ? AND node_id = ?").run('No branch led here.', runId, node.id);
          changed = true;
        }
      }
      if (changed) continue;
      const all = [...states.values()];
      if (all.some((node) => node.status === 'waiting' || node.status === 'running')) return;
      // A step skipped because no branch led to it is a normal outcome and
      // does not fail the run; only a step that actually failed does.
      const failedRun = all.some((node) => node.status === 'failed');
      this.db.prepare('UPDATE agent_flow_runs SET status = ?, finished_at = ? WHERE id = ?')
        .run(failedRun ? 'failed' : 'done', this.now().toISOString(), runId);
      return;
    }
  }

  private async startNode(run: RunRow, definition: Definition, node: FlowExecutionNode, states: Map<string, NodeRow>): Promise<void> {
    const fail = (note: string): void => { this.db.prepare("UPDATE agent_flow_run_nodes SET status = 'failed', note = ? WHERE run_id = ? AND node_id = ?").run(note, run.id, node.id); };
    const agent = this.deps.agents.get(node.agentId);
    if (agent === undefined) { fail('This agent no longer exists.'); return; }
    if (this.createTask === undefined) { fail('Conductor is still starting.'); return; }
    const built = definition.edges.filter((edge) => edge.to === node.id && (edge.when === undefined || states.get(edge.from)?.branch === edge.when.label)).flatMap((edge) => {
      const source = definition.nodes.find((item) => item.id === edge.from);
      const done = states.get(edge.from);
      if (source === undefined || done === undefined) return [];
      const who = isWaitKind(source.kind) ? 'The user replied by email' : this.deps.agents.get(source.agentId)?.name ?? 'An earlier step';
      return [`${who} finished and said:\n${done.output.trim() === '' ? '(no written answer; look at the files it saved)' : done.output.slice(0, MAX_HANDOFF)}`];
    });
    // A step a review sent back carries the reviewer's feedback into its next pass.
    const feedback = (states.get(node.id)?.pending_input ?? '').slice(0, MAX_OUTPUT);
    if (feedback !== '') this.db.prepare('UPDATE agent_flow_run_nodes SET pending_input = NULL WHERE run_id = ? AND node_id = ?').run(run.id, node.id);
    const task = node.prompt.replace(/\{\{\s*input\s*\}\}/g, run.input).trim();
    const objective = [
      `[Workflow “${definition.name}” — you are ${agent.name}. Do your step; the steps after yours build on what you leave. This is a new run: build everything fresh, and do not reuse files, links or results from earlier runs of this workflow unless your step says to.]`,
      run.input.trim() !== '' && !/\{\{\s*input\s*\}\}/.test(node.prompt) ? `Workflow input:\n${run.input}` : '',
      built.length > 0 ? `Work you build on:\n${built.join('\n\n')}` : '',
      feedback !== '' ? `Reviewer feedback from the last round — address every point before continuing:\n${feedback}` : '',
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

  /** Reply and review steps still waiting, with what is needed to match an answer to them. */
  private waitingReplies(): Array<{ runId: string; nodeId: string; startedAt: string; upstreamTasks: string[]; waitHours: number; onTimeout: ReviewVerdict | 'fail' }> {
    const rows = this.db.prepare(`SELECT n.run_id, n.node_id, n.started_at, r.definition FROM agent_flow_run_nodes n JOIN agent_flow_runs r ON r.id = n.run_id
      WHERE n.status = 'running' AND n.task_id IS NULL AND n.note LIKE 'Waiting for your reply%' AND r.status = 'running'`).all() as Array<{ run_id: string; node_id: string; started_at: string | null; definition: string }>;
    const out: ReturnType<AgentFlowService['waitingReplies']> = [];
    for (const row of rows) {
      const definition = parse<Definition>(row.definition, { name: '', nodes: [], edges: [] });
      const node = definition.nodes.find((item) => item.id === row.node_id);
      if (node === undefined || !isWaitKind(node.kind)) continue;
      const before = definition.edges.filter((edge) => edge.to === node.id).map((edge) => edge.from);
      const tasks = (this.db.prepare('SELECT node_id, task_id FROM agent_flow_run_nodes WHERE run_id = ?').all(row.run_id) as Array<{ node_id: string; task_id: string | null }>)
        .filter((item) => before.includes(item.node_id) && item.task_id !== null).map((item) => item.task_id as string);
      out.push({ runId: row.run_id, nodeId: row.node_id, startedAt: row.started_at ?? '', upstreamTasks: tasks, waitHours: node.waitHours ?? DEFAULT_REPLY_HOURS, onTimeout: node.onTimeout ?? 'fail' });
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
    const reply = `Subject: ${message.subject}\n${message.text}`.slice(0, MAX_OUTPUT);
    const run = this.db.prepare('SELECT definition FROM agent_flow_runs WHERE id = ?').get(target.runId) as { definition: string } | undefined;
    const definition = parse<Definition>(run?.definition ?? '', { name: '', nodes: [], edges: [] });
    const messageKey = `${message.threadId}:${message.id}`;
    if (definition.feedbackMessages?.includes(messageKey)) return;
    const node = definition.nodes.find((item) => item.id === target.nodeId);
    if (node?.kind === 'review' && node.cli !== undefined) {
      let claimed = false;
      this.deps.store.transaction(({ db }) => {
        const result = db.prepare("UPDATE agent_flow_run_nodes SET pending_input = ?, output = ?, note = 'Analyzing reviewer feedback.' WHERE run_id = ? AND node_id = ? AND status = 'running' AND note LIKE 'Waiting for your reply%'").run(reply, reply, target.runId, target.nodeId);
        if (result.changes === 0) return;
        claimed = true;
        definition.feedbackMessages = [...(definition.feedbackMessages ?? []), messageKey];
        db.prepare('UPDATE agent_flow_runs SET definition = ? WHERE id = ?').run(JSON.stringify(definition), target.runId);
      });
      if (!claimed) return;
      await this.routeFeedback(target.runId, target.nodeId);
      return;
    }
    if (node?.kind === 'review') { await this.reviewReplied(target.runId, target.nodeId, node, definition, message.text, reply); return; }
    // A plain reply step records which branch its text matched, so the arrows
    // out of it decide what continues without re-reading the email.
    const branch = matchBranch(definition, target.nodeId, message.text);
    this.db.prepare("UPDATE agent_flow_run_nodes SET status = 'done', output = ?, note = '', branch = ? WHERE run_id = ? AND node_id = ? AND status = 'running'")
      .run(reply, branch, target.runId, target.nodeId);
    await this.advance(target.runId);
  }

  /** Resume a persisted, read-only feedback decision, then execute the validated DAG. */
  private async routeFeedback(runId: string, nodeId: string): Promise<void> {
    const key = `${runId}:${nodeId}`;
    if (this.routing.has(key)) return;
    this.routing.add(key);
    try {
      const run = this.db.prepare('SELECT * FROM agent_flow_runs WHERE id = ?').get(runId) as RunRow;
      const definition = parse<Definition>(run.definition, { name: '', nodes: [], edges: [] });
      const node = definition.nodes.find((n) => n.id === nodeId);
      const state = this.db.prepare('SELECT * FROM agent_flow_run_nodes WHERE run_id = ? AND node_id = ?').get(runId, nodeId) as NodeRow;
      if (run.status !== 'running' || state.status !== 'running' || state.pending_input === null || node?.cli === undefined) return;
      if (this.feedbackRouter === undefined) throw new Error('Feedback routing agent is unavailable.');
      const states = this.db.prepare('SELECT * FROM agent_flow_run_nodes WHERE run_id = ?').all(runId) as NodeRow[];
      const result = await this.feedbackRouter({ prompt: feedbackPrompt(definition, nodeId, state.pending_input, states), cli: node.cli, ...(node.model !== undefined ? { model: node.model } : {}), ...(node.effort !== undefined ? { effort: node.effort } : {}) });
      if (result === undefined) throw new Error('The selected feedback CLI did not answer.');
      await this.withRunLock(runId, async () => {
        // Re-read and apply under the same lock as advance(), so an old graph
        // snapshot cannot start a consumer while its edges are being replaced.
        const current = this.db.prepare('SELECT * FROM agent_flow_runs WHERE id = ?').get(runId) as RunRow;
        if (current.status !== 'running') return;
        const currentDefinition = parse<Definition>(current.definition, definition);
        const currentNode = currentDefinition.nodes.find((n) => n.id === nodeId);
        const currentState = this.db.prepare('SELECT * FROM agent_flow_run_nodes WHERE run_id = ? AND node_id = ?').get(runId, nodeId) as NodeRow;
        if (currentNode?.kind !== 'review' || currentState.status !== 'running') return;
        const decision = parseFeedbackDecision(result, currentDefinition, nodeId);
        const changed = applyFeedbackDecision(currentDefinition, nodeId, decision, () => randomUUID());
        const rewinding = changed.added.length > 0;
        if (rewinding && currentState.rounds >= (currentNode.maxRounds ?? DEFAULT_MAX_ROUNDS)) throw new Error('The maximum number of feedback revisions was reached.');
        const latest = new Map((this.db.prepare('SELECT * FROM agent_flow_run_nodes WHERE run_id = ?').all(runId) as NodeRow[]).map((n) => [n.node_id, n]));
        if (rewinding) {
          for (const id of changed.replaced) {
            if (id !== nodeId && latest.get(id)?.status !== 'done') throw new Error('Cannot rewind a path with unfinished steps.');
            for (const edge of currentDefinition.edges.filter((e) => e.from === id && !changed.replaced.includes(e.to))) {
              if (latest.get(edge.to)?.status !== 'waiting') throw new Error('Cannot rewind work already consumed by another branch.');
            }
          }
        }
        const rounds = currentState.rounds + (rewinding ? 1 : 0);
        const structured = JSON.stringify(decision.feedback);
        this.deps.store.transaction(({ db }) => {
          db.prepare('UPDATE agent_flow_runs SET definition = ? WHERE id = ?').run(JSON.stringify(changed.definition), runId);
          db.prepare("UPDATE agent_flow_run_nodes SET status = 'done', pending_input = NULL, branch = ?, rounds = ?, note = ? WHERE run_id = ? AND node_id = ?")
            .run(rewinding ? 'revise' : 'approve', rounds, decision.feedback.summary, runId, nodeId);
          for (const added of changed.added) {
            db.prepare("INSERT INTO agent_flow_run_nodes (run_id, node_id, status, rounds, pending_input) VALUES (?, ?, 'waiting', ?, ?)")
              .run(runId, added.id, rounds, structured);
          }
          const selected = new Set(decision.route.next);
          if (!rewinding) for (const target of selected) {
            db.prepare("UPDATE agent_flow_run_nodes SET pending_input = CASE WHEN pending_input IS NULL OR pending_input = '' THEN ? ELSE pending_input || '\n\n' || ? END WHERE run_id = ? AND node_id = ? AND status = 'waiting'")
              .run(structured, structured, runId, target);
          }
          if (!rewinding) for (const edge of currentDefinition.edges.filter((e) => e.from === nodeId && !selected.has(e.to))) {
            const other = changed.definition.edges.some((e) => e.to === edge.to);
            if (!other) db.prepare("UPDATE agent_flow_run_nodes SET status = 'skipped', note = 'No branch led here.' WHERE run_id = ? AND node_id = ? AND status = 'waiting'").run(runId, edge.to);
          }
        });
      });
    } catch (error) {
      await this.withRunLock(runId, async () => {
        this.db.prepare("UPDATE agent_flow_run_nodes SET status = 'failed', pending_input = NULL, note = ? WHERE run_id = ? AND node_id = ? AND status = 'running'")
          .run(`Feedback routing failed: ${error instanceof Error ? error.message : String(error)}`, runId, nodeId);
      });
    } finally { this.routing.delete(key); }
    await this.advance(runId);
  }

  /**
   * A review step got its verdict. "revise" sends the work back to the step
   * being reviewed (bounded by maxRounds; once those rounds are used the flow
   * proceeds anyway with a note); "approve" lets the arrows labelled approve
   * continue. The loop is a reset, not a graph cycle: the reviewed step goes
   * back to waiting, and this review re-arms when it finishes again.
   */
  private async reviewReplied(runId: string, nodeId: string, node: FlowExecutionNode, definition: Definition, text: string, reply: string): Promise<void> {
    const row = this.db.prepare('SELECT rounds FROM agent_flow_run_nodes WHERE run_id = ? AND node_id = ?').get(runId, nodeId) as { rounds: number } | undefined;
    const rounds = (row?.rounds ?? 0) + 1;
    const verdict = classifyReview(definition, node, text);
    const maxRounds = node.maxRounds ?? DEFAULT_MAX_ROUNDS;
    if (node.loopTo !== undefined && verdict === 'revise' && rounds < maxRounds) {
      this.db.prepare("UPDATE agent_flow_run_nodes SET rounds = ?, status = 'waiting', output = ?, note = ? WHERE run_id = ? AND node_id = ? AND status = 'running'")
        .run(rounds, reply, `Sent back for round ${rounds} of changes.`, runId, nodeId);
      this.db.prepare("UPDATE agent_flow_run_nodes SET status = 'waiting', output = '', note = ?, pending_input = ? WHERE run_id = ? AND node_id = ?")
        .run(`Revision round ${rounds}: address the reviewer’s feedback.`, reply.slice(0, MAX_HANDOFF), runId, node.loopTo);
      await this.advance(runId);
      return;
    }
    // A looping review that runs out of rounds proceeds as approved, so the
    // main path continues; a review that only branches keeps its verdict.
    const approved = node.loopTo !== undefined && verdict === 'revise';
    const note = approved ? `${rounds} rounds of feedback came back; proceeding anyway.` : '';
    this.db.prepare("UPDATE agent_flow_run_nodes SET status = 'done', output = ?, note = ?, branch = ?, rounds = ? WHERE run_id = ? AND node_id = ? AND status = 'running'")
      .run(reply, note, approved ? 'approve' : verdict, rounds, runId, nodeId);
    await this.advance(runId);
  }

  /** Give up on replies that never came, and pick up replies that arrived while the app was closed or offline. */
  private async checkReplies(): Promise<void> {
    const waiting = this.waitingReplies();
    if (waiting.length === 0) return;
    const now = this.now().getTime();
    for (const item of waiting) {
      if (item.startedAt !== '' && now - new Date(item.startedAt).getTime() > item.waitHours * 3_600_000) {
        if (item.onTimeout === 'approve') {
          this.db.prepare("UPDATE agent_flow_run_nodes SET status = 'done', branch = 'approve', note = ? WHERE run_id = ? AND node_id = ? AND status = 'running'")
            .run(`No review reply came within ${item.waitHours} hours; proceeding as approved.`, item.runId, item.nodeId);
        } else {
          this.db.prepare("UPDATE agent_flow_run_nodes SET status = 'failed', note = ? WHERE run_id = ? AND node_id = ? AND status = 'running'").run(`No reply came within ${item.waitHours} hours.`, item.runId, item.nodeId);
        }
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
      WHERE status = 'running' AND task_id IS NULL AND note NOT LIKE 'Waiting for your reply%' AND note <> 'Analyzing reviewer feedback.' AND run_id IN (SELECT id FROM agent_flow_runs WHERE status = 'running')`).run();
    const pending = this.db.prepare("SELECT run_id, node_id FROM agent_flow_run_nodes WHERE status = 'running' AND note = 'Analyzing reviewer feedback.' AND pending_input IS NOT NULL").all() as Array<{ run_id: string; node_id: string }>;
    for (const item of pending) await this.routeFeedback(item.run_id, item.node_id);
    const rows = this.db.prepare(`SELECT n.task_id AS id, t.state FROM agent_flow_run_nodes n JOIN tasks t ON t.id = n.task_id WHERE n.status = 'running'`).all() as Array<{ id: string; state: string }>;
    for (const row of rows) await this.taskSettled({ id: row.id, state: row.state as Task['state'] });
    const open = this.db.prepare("SELECT id FROM agent_flow_runs WHERE status = 'running'").all() as Array<{ id: string }>;
    for (const { id } of open) await this.advance(id);
  }
}
