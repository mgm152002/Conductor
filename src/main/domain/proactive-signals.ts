import type { Connector } from '@shared/connector';
import type { Suggestion, Task } from '@shared/domain';
import type { Store } from '../db/types';
import type { SyncOutcome } from '../connectors/ingestion-worker';
import { revealForDisplayOnly } from '../orchestrator/data-channel';
import type { AuthorizedSources, ContextSignal, ProactiveAssistant, SuggestionExecutor } from './proactive-assistant-service';

// Produces proactive suggestions from what Conductor already observes:
//  * a task got blocked or interrupted → offer to retry / resume it;
//  * the same kind of task keeps failing → suggest reviewing agent setup;
//  * a new email asks a question → offer to draft a reply (never sends);
//  * a calendar event starts within a day → offer to prepare a briefing.
//
// Suggestions are suggest-only unless the user adds an auto-run rule for that
// action kind; anything with an external side effect always waits for the
// user. Sources: Conductor's own tasks, plus connectors the user authorized.

export const ORCHESTRATOR_SUBJECT = { type: 'agent' as const, id: 'orchestrator' };
export const TASK_SOURCE = 'conductor:tasks';

export interface SuggestionActions {
  retryTask(taskId: string): Promise<void>;
  resumeTask(taskId: string): Promise<void>;
  createTask(input: { workspaceId: string; objective: string }): Promise<void>;
}

/** Sources the assistant may monitor: Conductor's tasks and authorized connectors. */
export function connectorSources(store: Store): AuthorizedSources {
  return {
    isAuthorized(sourceId) {
      if (sourceId === TASK_SOURCE) return true;
      if (!sourceId.startsWith('connector:')) return false;
      const row = store.db.prepare('SELECT auth_state FROM connectors WHERE id = ?').get(sourceId.slice('connector:'.length)) as { auth_state: string } | undefined;
      return row?.auth_state === 'authorized';
    },
  };
}

export function suggestionExecutor(actions: SuggestionActions): SuggestionExecutor {
  return {
    async execute(suggestion: Suggestion) {
      const payload = (suggestion.action.payload ?? {}) as Record<string, unknown>;
      switch (suggestion.action.kind) {
        case 'retry_task': if (typeof payload['taskId'] === 'string') await actions.retryTask(payload['taskId']); return;
        case 'resume_task': if (typeof payload['taskId'] === 'string') await actions.resumeTask(payload['taskId']); return;
        case 'create_task':
          if (typeof payload['workspaceId'] === 'string' && typeof payload['objective'] === 'string') {
            await actions.createTask({ workspaceId: payload['workspaceId'], objective: payload['objective'] });
          }
          return;
        default:
          return; // informational suggestions (e.g. review setup) have nothing to run
      }
    },
  };
}

function short(text: string, max = 80): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export class ProactiveSignals {
  constructor(
    private readonly store: Store,
    private readonly assistant: ProactiveAssistant,
    private readonly activeWorkspace: () => string | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  /** Skip a signal when an equivalent suggestion is still pending. */
  private pending(kind: string, key: string): boolean {
    return this.assistant.listSuggestions().some((s) =>
      (s.status === 'suggested' || s.status === 'awaiting_authorization') && s.action.kind === kind && JSON.stringify(s.action.payload ?? null).includes(key));
  }

  private async emit(signal: ContextSignal, dedupKey: string): Promise<void> {
    if (this.pending(signal.action.kind, dedupKey)) return;
    try { await this.assistant.generate(signal); } catch { /* unauthorized source or executor failure: recorded by the assistant */ }
  }

  /** A task was blocked or interrupted. */
  async onTaskStuck(task: Task): Promise<void> {
    if (task.state !== 'BLOCKED' && task.state !== 'RECOVERABLE_INTERRUPTION') return;
    const resume = task.state === 'RECOVERABLE_INTERRUPTION';
    await this.emit({
      trigger: { kind: 'task_interrupted', sourceId: TASK_SOURCE, summary: `“${short(task.objective)}” is ${resume ? 'interrupted' : 'blocked'}`, observedAt: new Date(this.now()).toISOString() },
      action: {
        kind: resume ? 'resume_task' : 'retry_task',
        summary: resume ? 'Resume the interrupted task' : 'Retry the blocked task',
        externalSideEffect: false,
        permissionRequirements: [{ kind: 'command_exec' }],
        payload: { taskId: task.id },
      },
      explanation: task.recommendedNextAction ?? (resume ? 'The task stopped before it finished.' : 'The task could not start.'),
      subject: ORCHESTRATOR_SUBJECT,
    }, task.id);
  }

  /** A task finished; look for repeated failures of the same agent. */
  async onTaskFinished(task: Task): Promise<void> {
    if (task.state !== 'FAILED') return;
    const recent = this.store.db.prepare(
      `SELECT result, tool_usage FROM task_outcomes WHERE comparability_key = 'capability:objective.fulfill' ORDER BY recorded_at DESC, rowid DESC LIMIT 5`,
    ).all() as { result: string; tool_usage: string }[];
    const failuresByAgent = new Map<string, number>();
    for (const row of recent) {
      if (row.result !== 'failure') continue;
      for (const agent of JSON.parse(row.tool_usage) as string[]) failuresByAgent.set(agent, (failuresByAgent.get(agent) ?? 0) + 1);
    }
    for (const [agent, failures] of failuresByAgent) {
      if (failures < 3) continue;
      await this.emit({
        trigger: { kind: 'repeated_step_failure', sourceId: TASK_SOURCE, summary: `${agent} failed ${failures} of the last ${recent.length} tasks`, observedAt: new Date(this.now()).toISOString() },
        action: { kind: 'review_agent_setup', summary: `Check ${agent}'s sign-in, permissions and acceptance checks`, externalSideEffect: false, permissionRequirements: [], payload: { agent } },
        explanation: 'Repeated failures usually mean the agent is signed out, lacks permission, or the checks cannot be satisfied.',
      }, agent);
    }
  }

  /** New items arrived from a connector. */
  async onConnectorSynced(connector: Connector, outcome: SyncOutcome): Promise<void> {
    if (!outcome.succeeded || outcome.ingested.length === 0) return;
    const workspaceId = connector.config.workspaceId ?? this.activeWorkspace();
    if (workspaceId === undefined) return;
    const sourceId = `connector:${connector.id}`;
    const nowMs = this.now();
    for (const [index, item] of outcome.ingested.entries()) {
      const wrapper = outcome.data[index];
      if (wrapper === undefined) continue;
      const content = revealForDisplayOnly(wrapper);
      if (connector.kind === 'email') {
        const from = /^From: (.*)$/m.exec(content)?.[1] ?? '';
        const subject = /^Subject: (.*)$/m.exec(content)?.[1] ?? '(no subject)';
        const user = connector.config.email?.user.toLowerCase() ?? '';
        const recent = nowMs - Date.parse(item.sourceTimestamp) < 3 * 86_400_000;
        const body = content.split('\n\n').slice(1).join('\n\n').split(/\n>|\nOn .+ wrote:/)[0] ?? '';
        if (!recent || from.toLowerCase().includes(user) || !body.includes('?')) continue;
        await this.emit({
          trigger: { kind: 'email_awaiting_reply', sourceId, summary: `${short(from, 40)} asked a question: “${short(subject, 60)}”`, observedAt: new Date(nowMs).toISOString() },
          action: {
            kind: 'create_task', summary: 'Draft a reply (nothing is sent)', externalSideEffect: false, permissionRequirements: [{ kind: 'command_exec' }],
            payload: { workspaceId, objective: `Draft a reply to the email “${subject}” from ${from}. Use the indexed email and project context. Do not send anything; put the draft in your reply.`, item: item.id },
          },
          explanation: 'A recent email contains a question and has no reply from you in the index.',
          subject: ORCHESTRATOR_SUBJECT,
        }, item.id);
      } else if (connector.kind === 'calendar') {
        const startsAt = Date.parse(/^Starts \(ISO\): (.*)$/m.exec(content)?.[1] ?? '');
        const title = /^Event: (.*)$/m.exec(content)?.[1] ?? 'event';
        if (Number.isNaN(startsAt) || startsAt < nowMs || startsAt - nowMs > 86_400_000) continue;
        await this.emit({
          trigger: { kind: 'deadline_approaching', sourceId, summary: `“${short(title, 60)}” starts ${new Date(startsAt).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`, observedAt: new Date(nowMs).toISOString() },
          action: {
            kind: 'create_task', summary: 'Prepare a short briefing', externalSideEffect: false, permissionRequirements: [{ kind: 'command_exec' }],
            payload: { workspaceId, objective: `Prepare a short briefing for “${title}” (${new Date(startsAt).toISOString()}) using indexed notes, email and project context.`, item: item.id },
          },
          explanation: 'An event on your calendar starts within the next day.',
          subject: ORCHESTRATOR_SUBJECT,
        }, item.id);
      }
    }
  }
}
