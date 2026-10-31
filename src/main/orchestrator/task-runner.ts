import { existsSync, rmdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_ATTACHMENT_EXTRACTED_CHARS, type MaterializedAttachment } from '@shared/attachments';
import type { AttachmentService } from '../attachments/attachment-service';
import { lastAdapterFor } from './thread-context';
import type { ToolApprovalBroker } from './tool-approvals';
import type { RunOptions } from '@shared/agent-models';
import { randomUUID } from 'node:crypto';
import type { Store } from '../db/types';
import type { Orchestrator, CreateTaskInput } from './orchestrator';
import type { TaskStateMachine } from './state-machine';
import { isTerminal } from './state-machine';
import type { PermissionService } from '../domain/permission-service';
import type { Registry } from '../registry/registry';
import type { AuditLog } from '../domain/audit-log';
import type { TaskEventEmitter } from './event-emitter';
import type { PlanDecomposition } from './planner';
import type { Task, DagWorkflow } from '@shared/domain';
import type { QueuedMessage, QueuedMessageMode } from '@shared/message-queue';

interface TaskRunnerDeps {
  attachments?: AttachmentService;
  store: Store;
  orchestrator: Orchestrator;
  stateMachine: TaskStateMachine;
  permissions: PermissionService;
  registry: Registry;
  audit: AuditLog;
  emitter: TaskEventEmitter;
  /** Observes tasks that reached COMPLETED or FAILED (learning, suggestions). */
  onFinished?: (task: Task) => void;
  /** Observes tasks that became BLOCKED or RECOVERABLE_INTERRUPTION. */
  onStuck?: (task: Task) => void;
  /** Per-tool-call approvals from running agents. */
  toolApprovals?: ToolApprovalBroker;
  /** Plan mode: records that a task is planned by a chosen agent. */
  planMode?: { request(taskId: string, plannerAdapterId: string): void };
  /** Saves the composer's model/effort choices for a message. */
  runOptions?: { save(taskId: string, options: RunOptions, mainAgentId?: string): void };
  /** Loads agents' model lists so Auto routing can pick a model (bounded wait). */
  warmModels?: (agentIds: string[]) => Promise<void>;
  /** Names a new thread from its first message (fire-and-forget, background). */
  onThreadCreated?: (task: Task) => void;
}

const WARM_WAIT_MS = 4_000;

/** Application lifecycle driver. Low-level orchestration methods remain independently testable. */
export class TaskRunner {
  private readonly attachmentLoads = new Map<string, Promise<MaterializedAttachment[]>>();
  private readonly running = new Map<string, Promise<void>>();
  constructor(private readonly deps: TaskRunnerDeps) {}

  async create(input: CreateTaskInput & { agentId?: string; plan?: boolean; runOptions?: RunOptions; attachmentIds?: readonly string[] }): Promise<Task> {
    const { agentId, plan, runOptions, attachmentIds = [], ...rest } = input;
    if (attachmentIds.length > 0 && !this.deps.attachments) throw new Error('Attachments are not available. Remove the files and try again.');
    this.deps.attachments?.validate(attachmentIds);
    if (plan === true) {
      // Plan mode: the chosen agent plans, then each plan task runs on its agent.
      if (this.deps.planMode === undefined) throw new Error('Plan mode is not available.');
      if (agentId === undefined) throw new Error('Choose the agent that should write the plan.');
      if (!this.agentAvailable(agentId)) throw new Error(`The selected planner (${agentId}) is not available. Check Connections, or choose another agent.`);
    } else if (agentId !== undefined && !this.agentAvailable(agentId)) {
      throw new Error(`The selected agent (${agentId}) is not available. Check Connections, or choose Auto.`);
    }
    const task = await this.deps.orchestrator.createTask({
      ...rest,
      acceptanceCriteria: rest.acceptanceCriteria?.length ? rest.acceptanceCriteria : ['response: nonempty'],
    });
    if (attachmentIds.length > 0) {
      const destination = this.attachmentDirectory(task);
      try {
        this.deps.attachments!.linkTask(task.id, attachmentIds);
        await this.deps.attachments!.materialize(attachmentIds, destination, { taskId: task.id });
      } catch (error) {
        // Preserve draft blobs for retry while removing any partial copies/links.
        const paths = this.deps.store.db.prepare('SELECT materialized_path FROM task_attachments WHERE task_id=?').all(task.id) as { materialized_path: string | null }[];
        for (const { materialized_path: path } of paths) if (path) rmSync(path, { force: true });
        this.deps.store.db.prepare('DELETE FROM tasks WHERE id=?').run(task.id);
        try { rmdirSync(destination); } catch { /* absent or not empty */ }
        throw error;
      }
    }
    // Record which agent the message's model choice belongs to — the explicit
    // pick, or (for a follow-up) the previous turn's agent that will continue
    // — even when only the model changed, so the choice stays bound to its own
    // CLI: if the step later falls back to another provider, that provider
    // runs its own Settings/Auto model instead of a foreign model id.
    const mainAgentId = plan === true ? agentId : (agentId ?? this.continueAdapterId(task));
    if (runOptions !== undefined || mainAgentId !== undefined) {
      this.deps.runOptions?.save(task.id, runOptions ?? {}, mainAgentId);
    }
    // Name the thread from its first message in the background; creation and
    // execution never wait on the title call. Scheduled only after the run
    // options above are saved, so title generation can pin itself to the
    // model this thread will actually run on.
    if (task.parentTaskId === undefined) {
      try { this.deps.onThreadCreated?.(task); } catch { /* titles never block work */ }
    }
    // Auto routing needs the agent's model list; usually cached already.
    if (this.deps.warmModels !== undefined) {
      const agents = agentId !== undefined && plan !== true ? [agentId] : this.deps.registry.listAdapters().map((a) => a.id);
      await Promise.race([this.deps.warmModels(agents).catch(() => undefined), new Promise((r) => setTimeout(r, WARM_WAIT_MS))]);
    }
    if (plan === true) {
      this.deps.planMode!.request(task.id, agentId!);
      this.drive(task.id);
      return task;
    }
    this.drive(task.id, agentId !== undefined ? this.pinnedPlan(task, agentId) : this.followUpPlan(task));
    return task;
  }

  private attachmentDirectory(task: Task): string {
    const workspace = this.deps.store.db.prepare('SELECT root_path FROM workspaces WHERE id=?').get(task.workspaceId) as { root_path: string } | undefined;
    if (!workspace) throw new Error('The attachment workspace no longer exists.');
    return join(workspace.root_path, '.conductor', 'attachments', task.id);
  }

  /** Keep existing paths stable across parallel plan steps and app restarts. */
  executionAttachments(task: Task): Promise<MaterializedAttachment[]> {
    const pending = this.attachmentLoads.get(task.id);
    if (pending) return pending;
    const loading = this.loadExecutionAttachments(task).finally(() => this.attachmentLoads.delete(task.id));
    this.attachmentLoads.set(task.id, loading);
    return loading;
  }

  private async loadExecutionAttachments(task: Task): Promise<MaterializedAttachment[]> {
    const service = this.deps.attachments;
    if (!service) return [];
    const refs = service.listTask(task.id);
    return Promise.all(refs.map(async (ref) => {
      const row = this.deps.store.db.prepare('SELECT materialized_path FROM task_attachments WHERE task_id=? AND attachment_id=?').get(task.id, ref.id) as { materialized_path: string | null };
      if (!row.materialized_path || !existsSync(row.materialized_path)) {
        return (await service.materialize([ref.id], this.attachmentDirectory(task), { taskId: task.id }))[0]!;
      }
      const preview = await service.preview(ref.id);
      const text = preview.format === 'markdown' ? preview.markdown : preview.format === 'text' ? preview.text
        : preview.format === 'pdf' ? preview.pages.map((page) => page.text).join('\n\n') : undefined;
      return { ...ref, path: row.materialized_path,
        ...(text !== undefined ? { extractedText: text.slice(0, MAX_ATTACHMENT_EXTRACTED_CHARS), truncated: preview.truncated || text.length > MAX_ATTACHMENT_EXTRACTED_CHARS } : {}),
        ...(preview.format === 'pdf' ? { pageCount: preview.pageCount } : {}),
      };
    }));
  }

  private agentAvailable(adapterId: string): boolean {
    return this.deps.registry.adaptersSupporting(`objective.fulfill.${adapterId}`).some((adapter) => adapter.available);
  }

  private pinnedPlan(task: Task, adapterId: string): PlanDecomposition {
    return { steps: [{ id: 'step-1', description: `${task.parentTaskId !== undefined ? 'Continue the conversation' : 'Fulfill objective'}: ${task.objective}`, requiredCapability: `objective.fulfill.${adapterId}` }] };
  }

  /**
   * A follow-up continues with the agent that ran the previous turn when it is
   * still available (so Codex can resume its session); otherwise routing picks
   * any compatible agent and the earlier turns are passed as reference.
   */
  /** The previous turn's agent when a follow-up will continue on it, if still available. */
  private continueAdapterId(task: Task): string | undefined {
    if (task.parentTaskId === undefined) return undefined;
    const adapterId = lastAdapterFor(this.deps.store, task.parentTaskId);
    return adapterId !== undefined && this.agentAvailable(adapterId) ? adapterId : undefined;
  }

  private followUpPlan(task: Task): PlanDecomposition | undefined {
    const adapterId = this.continueAdapterId(task);
    return adapterId === undefined ? undefined : this.pinnedPlan(task, adapterId);
  }

  async startWorkflow(workflow: DagWorkflow, workspaceId: string): Promise<Task> {
    if (workflow.steps.some((s) => s.branch || s.loop || s.policy || s.errorRecovery) ||
        workflow.errorRecovery.kind !== 'abort' || workflow.memoryUpdates.length > 0) {
      throw new Error('Task execution currently supports dependency-only workflows with the default abort policy. Branches, loops, custom policies and memory updates are not connected to task execution yet.');
    }
    const task = await this.deps.orchestrator.createTask({
      workspaceId,
      objective: `Run workflow: ${workflow.name} (version ${workflow.version})`,
      acceptanceCriteria: workflow.validationCriteria.length
        ? workflow.validationCriteria.map((c) => c.description) : ['response: nonempty'],
    });
    try { this.deps.onThreadCreated?.(task); } catch { /* titles never block work */ }
    const plan: PlanDecomposition = {steps: workflow.steps.map((step) => ({
      id: step.id, description: step.description, requiredCapability: step.requiredCapability,
      dependsOn: step.dependsOn,
      requiredPermissions: step.requiresApproval
        ? [...(step.requiredPermissions ?? []), {kind:'command_exec' as const}]
        : step.requiredPermissions ?? [],
    }))};
    this.deps.store.db.prepare('INSERT INTO workflow_tasks(task_id,workflow_id,version) VALUES (?,?,?)').run(task.id,workflow.workflowId,workflow.version);
    this.drive(task.id, plan);
    return task;
  }

  /** Schedule once per task; repeated clicks never launch duplicate sessions. */
  drive(taskId: string, plan?: PlanDecomposition): void {
    if (this.running.has(taskId)) return;
    const promise = Promise.resolve().then(async () => {
      const {orchestrator, store, emitter} = this.deps;
      let task = orchestrator.getTask(taskId);
      if (!task || isTerminal(task.state)) return;
      if (task.state === 'CREATED') await orchestrator.beginExecution(taskId, plan);
      task = orchestrator.getTask(taskId)!;
      if (task.state === 'BLOCKED' || task.state === 'RECOVERABLE_INTERRUPTION') {
        const count = store.db.prepare('SELECT COUNT(*) AS n FROM task_steps WHERE task_id=?').get(taskId) as {n:number};
        this.deps.stateMachine.transition({taskId,to:'PLANNING',eventPayload:{reason:'retry'}});
        // The previous failure reason no longer applies to this attempt.
        store.db.prepare('UPDATE tasks SET recommended_next_action = NULL WHERE id = ?').run(taskId);
        if (count.n === 0) await orchestrator.planTask(taskId, plan);
      }
      task = orchestrator.getTask(taskId)!;
      if (task.state === 'PLANNING' || task.state === 'RUNNING' || task.state === 'WAITING_FOR_APPROVAL') {
        await orchestrator.runSteps(taskId);
      }
      if (orchestrator.getTask(taskId)?.state === 'VERIFYING') await orchestrator.verifyTask(taskId);
      const settled = orchestrator.getTask(taskId);
      emitter.emit('task.updated', settled);
      if (settled !== undefined) this.notify(settled);
      if (settled !== undefined) await this.dispatchAfterSettle(settled);
    }).catch((err: unknown) => this.fail(taskId, err)).finally(() => this.running.delete(taskId));
    this.running.set(taskId, promise);
  }

  isRunning(taskId:string):boolean { return this.running.has(taskId); }

  async waitForIdle(taskId: string): Promise<void> { await this.running.get(taskId); }

  // ---- Steer & queue: messages sent while a task is working ----

  /**
   * Accept a message for a thread whose latest task is still working.
   * `queue` stores it durably; it dispatches FIFO as a follow-up once the
   * working task settles. `steer` stores it, cancels the working task, waits
   * for its drive loop to exit, then dispatches it ahead of queued messages.
   * Adapters have no mid-run input channel, so steering is interrupt+resume:
   * the follow-up continues the thread (provider session resumed when the
   * same agent continues, earlier turns passed as reference otherwise).
   */
  async enqueueMessage(input: {
    taskId: string; objective: string; mode: QueuedMessageMode;
    acceptanceCriteria?: readonly string[]; agentId?: string;
    runOptions?: RunOptions; attachmentIds?: readonly string[];
  }): Promise<QueuedMessage> {
    const anchor = this.deps.orchestrator.getTask(input.taskId);
    if (anchor === undefined) throw new Error('The working task was not found.');
    if (isTerminal(anchor.state)) throw new Error('That task already finished. Send the message as a normal reply.');
    const objective = input.objective.trim();
    if (objective.length < 1 || objective.length > 10_000) throw new Error('Message must be 1–10,000 characters.');
    if (input.agentId !== undefined && !this.agentAvailable(input.agentId)) {
      throw new Error(`The selected agent (${input.agentId}) is not available. Check Connections, or choose Auto.`);
    }
    const attachmentIds = [...(input.attachmentIds ?? [])];
    if (attachmentIds.length > 0 && !this.deps.attachments) throw new Error('Attachments are not available. Remove the files and try again.');
    this.deps.attachments?.validate(attachmentIds);
    const entry: QueuedMessage = {
      id: randomUUID(), anchorTaskId: anchor.id, threadId: anchor.threadId ?? anchor.id,
      objective, mode: input.mode, status: 'pending', createdAt: new Date().toISOString(),
    };
    this.deps.store.db.prepare(
      `INSERT INTO task_message_queue (id, anchor_task_id, thread_id, workspace_id, objective, acceptance_criteria, agent_id, run_options, attachment_ids, mode, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(entry.id, entry.anchorTaskId, entry.threadId, anchor.workspaceId, objective,
      JSON.stringify([...(input.acceptanceCriteria ?? [])]),
      input.agentId ?? null,
      input.runOptions !== undefined ? JSON.stringify(input.runOptions) : null,
      JSON.stringify(attachmentIds), entry.mode, entry.createdAt, entry.createdAt);
    this.emitQueue(entry.threadId);
    if (entry.mode === 'steer') void this.steer(entry).catch(() => undefined);
    return entry;
  }

  /** Pending (and currently dispatching) messages for a thread, in dispatch order. */
  listQueuedMessages(threadId: string): QueuedMessage[] {
    const rows = this.deps.store.db.prepare(
      `SELECT id, anchor_task_id, thread_id, objective, mode, status, dispatched_task_id, created_at
       FROM task_message_queue WHERE thread_id = ? AND status IN ('pending', 'dispatching')
       ORDER BY (mode = 'steer') DESC, created_at ASC, rowid ASC`,
    ).all(threadId) as QueueRow[];
    return rows.map(rowToQueuedMessage);
  }

  async cancelQueuedMessage(id: string): Promise<void> {
    const row = this.deps.store.db.prepare('SELECT thread_id FROM task_message_queue WHERE id = ? AND status = \'pending\'').get(id) as { thread_id: string } | undefined;
    if (row === undefined) throw new Error('That queued message is no longer waiting.');
    this.deps.store.db.prepare("UPDATE task_message_queue SET status = 'cancelled', updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
    this.emitQueue(row.thread_id);
  }

  private async steer(entry: QueuedMessage): Promise<void> {
    await this.deps.orchestrator.cancelTask(entry.anchorTaskId);
    await this.waitForIdle(entry.anchorTaskId);
    await this.dispatchQueued(entry.threadId);
  }

  /** Dispatch after a drive settles; blocked/interrupted work keeps its queue waiting. */
  private async dispatchAfterSettle(settled: Task): Promise<void> {
    if (settled.state === 'BLOCKED' || settled.state === 'RECOVERABLE_INTERRUPTION' || settled.state === 'WAITING_FOR_APPROVAL') return;
    await this.dispatchQueued(settled.threadId ?? settled.id);
  }

  private readonly dispatchingThreads = new Set<string>();

  /**
   * Dispatch the next waiting message of a thread as a follow-up task, at
   * most one at a time. Steer entries go first; after cancellation only a
   * steer entry may dispatch (a plain Stop must not unleash queued work).
   */
  async dispatchQueued(threadId: string): Promise<void> {
    if (this.dispatchingThreads.has(threadId)) return;
    this.dispatchingThreads.add(threadId);
    try {
      for (;;) {
        const next = this.listQueuedMessages(threadId).find((m) => m.status === 'pending');
        if (next === undefined) return;
        const newest = this.deps.store.db.prepare(
          'SELECT id, state FROM tasks WHERE thread_id = ? OR id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
        ).get(threadId, threadId) as { id: string; state: Task['state'] } | undefined;
        if (newest === undefined) return;
        if (!isTerminal(newest.state)) return; // something in the thread is still working
        if (newest.state === 'CANCELLED' && next.mode !== 'steer') return;
        const claimed = this.deps.store.db.prepare(
          "UPDATE task_message_queue SET status = 'dispatching', updated_at = ? WHERE id = ? AND status = 'pending'",
        ).run(new Date().toISOString(), next.id);
        if (claimed.changes === 0) continue;
        this.emitQueue(threadId);
        const row = this.deps.store.db.prepare(
          'SELECT workspace_id, objective, acceptance_criteria, agent_id, run_options, attachment_ids, mode FROM task_message_queue WHERE id = ?',
        ).get(next.id) as { workspace_id: string; objective: string; acceptance_criteria: string; agent_id: string | null; run_options: string | null; attachment_ids: string; mode: QueuedMessageMode };
        try {
          const created = await this.create({
            workspaceId: row.workspace_id,
            objective: row.objective,
            acceptanceCriteria: JSON.parse(row.acceptance_criteria) as string[],
            parentTaskId: newest.id,
            ...(row.agent_id !== null ? { agentId: row.agent_id } : {}),
            ...(row.run_options !== null ? { runOptions: JSON.parse(row.run_options) as RunOptions } : {}),
            attachmentIds: JSON.parse(row.attachment_ids) as string[],
          });
          this.deps.store.db.prepare("UPDATE task_message_queue SET status = 'dispatched', dispatched_task_id = ?, updated_at = ? WHERE id = ?")
            .run(created.id, new Date().toISOString(), next.id);
          this.emitQueue(threadId);
          return; // the follow-up is now the working task; the rest wait for it
        } catch {
          this.deps.store.db.prepare("UPDATE task_message_queue SET status = 'failed', updated_at = ? WHERE id = ?")
            .run(new Date().toISOString(), next.id);
          this.emitQueue(threadId);
        }
      }
    } finally {
      this.dispatchingThreads.delete(threadId);
    }
  }

  private emitQueue(threadId: string): void {
    try { this.deps.emitter.emit('task.queue.updated', { threadId, queue: this.listQueuedMessages(threadId) }); } catch { /* renderer is optional */ }
  }

  async resolveApproval(input: {approvalId:string;decision:'approved'|'denied';remember?:boolean}): Promise<void> {
    // A tool call from a running agent: answer it; the task keeps running.
    if (this.deps.toolApprovals?.resolve(input.approvalId, input.decision, input.remember === true)) return;
    const {permissions,orchestrator} = this.deps;
    const decision = input.decision === 'approved' ? permissions.approve(input.approvalId) : permissions.deny(input.approvalId);
    this.deps.emitter.emit('task.updated', orchestrator.getTask(decision.request.taskId));
    if (!decision.resolved) return;
    if (input.decision === 'denied') await orchestrator.cancelTask(decision.request.taskId);
    else this.drive(decision.request.taskId);
  }

  private fail(taskId: string, err: unknown): void {
    const {store,stateMachine,orchestrator,audit,emitter} = this.deps;
    const task = orchestrator.getTask(taskId);
    if (!task || isTerminal(task.state)) return;
    const message = err instanceof Error ? err.message : 'Task execution failed';
    const reason = err instanceof Error && err.name === 'PlanRoutingError' ? message
      : /rout|adapter|capabilit/i.test(message)
        ? `${message}. Configure an agent in Connections and check permissions in Settings, then retry.` : message;
    // Persist failure detail even when no adapter session was ever started.
    store.db.prepare("INSERT INTO task_events (id,task_id,kind,payload,created_at) VALUES (?,?,'error',?,?)")
      .run(randomUUID(),taskId,JSON.stringify({error:reason}),new Date().toISOString());
    if (['PLANNING','RUNNING','CONTEXT_LOADING'].includes(task.state)) {
      stateMachine.transition({taskId,to:'BLOCKED',eventPayload:{reason}});
    } else if (task.state !== 'BLOCKED') {
      stateMachine.transition({taskId,to:'RECOVERABLE_INTERRUPTION',eventPayload:{reason}});
    }
    store.db.prepare('UPDATE tasks SET recommended_next_action = ? WHERE id = ?').run(reason,taskId);
    audit.append({actor:'orchestrator',action:'task.execution.blocked',target:taskId,redactedPayload:{reason}});
    const stuck = orchestrator.getTask(taskId);
    emitter.emit('task.updated',stuck);
    if (stuck !== undefined) this.notify(stuck);
  }

  /** Observers must never affect task execution. */
  private notify(task: Task): void {
    try {
      if (task.state === 'COMPLETED' || task.state === 'FAILED') this.deps.onFinished?.(task);
      else if (task.state === 'BLOCKED' || task.state === 'RECOVERABLE_INTERRUPTION') this.deps.onStuck?.(task);
    } catch { /* ignored */ }
  }
}

interface QueueRow {
  id: string;
  anchor_task_id: string;
  thread_id: string;
  objective: string;
  mode: QueuedMessageMode;
  status: QueuedMessage['status'];
  dispatched_task_id: string | null;
  created_at: string;
}

function rowToQueuedMessage(row: QueueRow): QueuedMessage {
  return {
    id: row.id, anchorTaskId: row.anchor_task_id, threadId: row.thread_id,
    objective: row.objective, mode: row.mode, status: row.status, createdAt: row.created_at,
    ...(row.dispatched_task_id !== null ? { dispatchedTaskId: row.dispatched_task_id } : {}),
  };
}
