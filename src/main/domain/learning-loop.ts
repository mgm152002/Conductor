import type { ImprovementProposal, PerformanceBaseline, Task, TaskOutcome } from '@shared/domain';
import type { Store } from '../db/types';
import type { SelfLearningEngine } from './self-learning-service';

// Connects the SelfLearningEngine to real task execution.
//
//  1. Every finished task (COMPLETED / FAILED) records an outcome: duration,
//     failed steps, retries, per-criterion verification and the agents used.
//  2. When comparable outcomes show one agent finishing a kind of work with
//     fewer failures (or faster) than the baseline, a `routing_rule` candidate
//     is evaluated; the engine only proposes it when it is a demonstrated
//     improvement over at least MIN_IMPROVEMENT_EXAMPLES prior tasks.
//  3. An approved routing rule takes effect through routing's historical
//     performance signal (the preferred agent wins ties).
//  4. Outcomes from tasks routed under an approved rule are attributed to it,
//     and a regression rolls it back automatically.
//
// Nothing here edits code or settings; it only writes learned artifacts.

export const MIN_AGENT_SAMPLES = 3;

export interface RoutingRulePayload {
  capability: string;
  preferAdapterId: string;
}

function isRoutingPayload(value: unknown): value is RoutingRulePayload {
  const v = value as Partial<RoutingRulePayload> | null;
  return v !== null && typeof v === 'object' && typeof v.capability === 'string' && typeof v.preferAdapterId === 'string';
}

function summarize(outcomes: readonly TaskOutcome[]): PerformanceBaseline {
  const n = outcomes.length;
  if (n === 0) return { sampleSize: 0, failureRate: 0, meanDurationMs: 0 };
  return {
    sampleSize: n,
    failureRate: outcomes.filter((o) => o.result === 'failure').length / n,
    meanDurationMs: outcomes.reduce((sum, o) => sum + o.durationMs, 0) / n,
  };
}

/** Comparable tasks share a key: workflow runs by workflow, everything else by capability. */
export function comparabilityKeyFor(store: Store, task: Task): string {
  const workflow = store.db.prepare('SELECT workflow_id FROM workflow_tasks WHERE task_id = ?').get(task.id) as { workflow_id: string } | undefined;
  return workflow !== undefined ? `workflow:${workflow.workflow_id}` : 'capability:objective.fulfill';
}

export class LearningLoop {
  constructor(private readonly store: Store, private readonly engine: SelfLearningEngine) {}

  /** Approved routing rules currently in effect. */
  activeRoutingRules(): (ImprovementProposal & { payload: RoutingRulePayload })[] {
    return this.engine.listProposals('approved')
      .filter((p): p is ImprovementProposal & { payload: RoutingRulePayload } => p.kind === 'routing_rule' && isRoutingPayload(p.payload));
  }

  /**
   * Routing's historical-performance oracle: 1 for an agent an approved rule
   * prefers for the capability, 0.5 otherwise. Pure for a given DB state.
   */
  routingScore(adapterId: string, capabilityId: string): number {
    const capability = capabilityId.startsWith('objective.fulfill') ? 'objective.fulfill' : capabilityId;
    return this.activeRoutingRules().some((rule) => rule.payload.capability === capability && rule.payload.preferAdapterId === adapterId) ? 1 : 0.5;
  }

  /** Record a finished task and run the improvement cycle. Never throws. */
  onTaskFinished(task: Task): { outcome?: TaskOutcome; proposal?: ImprovementProposal } {
    if (task.state !== 'COMPLETED' && task.state !== 'FAILED') return {};
    try {
      const already = this.store.db.prepare('SELECT 1 FROM task_outcomes WHERE task_id = ?').get(task.id);
      if (already !== undefined) return {};
      const steps = this.store.db.prepare('SELECT status, assigned_adapter_id FROM task_steps WHERE task_id = ?').all(task.id) as { status: string; assigned_adapter_id: string | null }[];
      const adapters = [...new Set(steps.map((s) => s.assigned_adapter_id).filter((a): a is string => a !== null))];
      const sessions = (this.store.db.prepare('SELECT COUNT(*) AS n FROM agent_sessions WHERE task_id = ?').get(task.id) as { n: number }).n;
      const verification = this.store.db.prepare(
        `SELECT snapshot FROM checkpoints WHERE task_id = ? AND json_type(snapshot, '$.criteria') = 'array' ORDER BY rowid DESC LIMIT 1`,
      ).get(task.id) as { snapshot: string } | undefined;
      const criteria = verification !== undefined
        ? ((JSON.parse(verification.snapshot) as { criteria?: { criterion: string; satisfied: boolean }[] }).criteria ?? [])
        : [];
      const key = comparabilityKeyFor(this.store, task);
      const rule = this.activeRoutingRules().find((r) => adapters.includes(r.payload.preferAdapterId) && key === r.comparabilityKey);
      const outcome = this.engine.record({
        taskId: task.id,
        comparabilityKey: key,
        result: task.state === 'COMPLETED' ? 'success' : 'failure',
        durationMs: Math.max(0, Date.parse(task.updatedAt) - Date.parse(task.createdAt)),
        failureCount: steps.filter((s) => s.status === 'failed').length,
        retryCount: Math.max(0, sessions - steps.length),
        verificationResults: criteria.map((c) => ({ criterion: c.criterion, passed: c.satisfied })),
        toolUsage: adapters,
        ...(rule !== undefined ? { improvementId: rule.id } : {}),
      });
      if (rule !== undefined) this.engine.checkRegression(rule.id);
      const proposal = this.maybePropose(key);
      return { outcome, ...(proposal !== undefined ? { proposal } : {}) };
    } catch {
      return {};
    }
  }

  /** Every comparability key with recorded outcomes, oldest first seen. */
  comparabilityKeys(): string[] {
    const rows = this.store.db.prepare('SELECT DISTINCT comparability_key FROM task_outcomes ORDER BY comparability_key ASC').all() as { comparability_key: string }[];
    return rows.map((r) => r.comparability_key);
  }

  /** Per-agent performance for every comparability key (for the LLM digest). */
  allAgentStats(): { comparabilityKey: string; agents: { adapterId: string; stats: PerformanceBaseline }[] }[] {
    return this.comparabilityKeys().map((comparabilityKey) => ({ comparabilityKey, agents: this.agentStats(comparabilityKey) }));
  }

  outcomeCount(): number {
    return (this.store.db.prepare('SELECT COUNT(*) AS n FROM task_outcomes').get() as { n: number }).n;
  }

  /** Per-agent performance for a comparability key (for the UI). */
  agentStats(key = 'capability:objective.fulfill'): { adapterId: string; stats: PerformanceBaseline }[] {
    const byAgent = new Map<string, TaskOutcome[]>();
    for (const outcome of this.engine.comparableOutcomes(key)) {
      for (const adapterId of outcome.toolUsage.slice(0, 1)) {
        byAgent.set(adapterId, [...(byAgent.get(adapterId) ?? []), outcome]);
      }
    }
    return [...byAgent.entries()].map(([adapterId, outcomes]) => ({ adapterId, stats: summarize(outcomes) }))
      .sort((a, b) => b.stats.sampleSize - a.stats.sampleSize);
  }

  private maybePropose(key: string): ImprovementProposal | undefined {
    const agents = this.agentStats(key).filter((a) => a.stats.sampleSize >= MIN_AGENT_SAMPLES);
    if (agents.length < 2) return undefined;
    const best = [...agents].sort((a, b) => a.stats.failureRate - b.stats.failureRate || a.stats.meanDurationMs - b.stats.meanDurationMs)[0]!;
    const capability = key.startsWith('capability:') ? key.slice('capability:'.length) : 'objective.fulfill';
    const open = this.engine.listProposals().some((p) =>
      (p.status === 'proposed' || p.status === 'approved') && p.kind === 'routing_rule' && p.comparabilityKey === key
      && isRoutingPayload(p.payload) && p.payload.preferAdapterId === best.adapterId);
    if (open) return undefined;
    const evaluation = this.engine.evaluate({
      comparabilityKey: key,
      kind: 'routing_rule',
      summary: `Prefer ${best.adapterId} for ${key.startsWith('workflow:') ? 'this workflow' : 'tasks'}: ${Math.round((1 - best.stats.failureRate) * 100)}% success over ${best.stats.sampleSize} runs`,
      payload: { capability, preferAdapterId: best.adapterId } satisfies RoutingRulePayload,
    }, best.stats);
    return evaluation.classification === 'demonstrated' ? evaluation.proposal : undefined;
  }
}
