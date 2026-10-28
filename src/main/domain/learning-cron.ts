import { randomUUID } from 'node:crypto';
import { MIN_IMPROVEMENT_EXAMPLES } from '@shared/domain';
import {
  DEFAULT_LEARNING_CONFIG, LEARNING_INTERVAL_MS,
  type LearningConfig, type LearningRun, type LearningStatus,
} from '@shared/learning-contract';
import type { AuditLog } from './audit-log';
import type { LearningLoop } from './learning-loop';
import type { SelfLearningEngine } from './self-learning-service';
import type { SettingsService } from './settings-service';
import { NO_VALUE } from './settings-service';
import type { LearningAnalyzer } from './learning-analyzer';
import { MIN_AGENT_SAMPLES } from './learning-loop';

// Cron-driven learning (Learning tab). Every 5 minutes — and on demand via
// "Run now" — the user-approved LLM reviews per-agent success rates and the
// recent audit log and suggests routing. Each suggestion is still gated by
// the deterministic SelfLearningEngine: it becomes a proposal only when the
// measured evidence demonstrates an improvement, and the preferred agent
// must actually be the empirical winner for that key. In `manual` mode the
// proposal waits for the user's Approve/Reject; in `auto` mode a
// demonstrated proposal is approved (and therefore routed) immediately.
// Regression rollback of approved rules is unchanged (LearningLoop).

export const LEARNING_CONFIG_KEY = 'learning.config';
export const LEARNING_LAST_RUN_KEY = 'learning.lastRun';

const AGENT_ID = /^[\w:.-]{1,200}$/;
const MODEL_ID = /^[\w./:@-]{1,100}$/;

export interface LearningCronDeps {
  settings: SettingsService;
  audit: AuditLog;
  learningLoop: LearningLoop;
  engine: SelfLearningEngine;
  analyzer: LearningAnalyzer;
  /** Agents the user may approve as the analyzer (available adapter ids). */
  availableAgents: () => string[];
  intervalMs?: number;
  now?: () => number;
}

export class LearningCronService {
  private readonly intervalMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<LearningRun> | undefined;
  private nextRunAt: string | undefined;

  constructor(private readonly deps: LearningCronDeps) {
    this.intervalMs = deps.intervalMs ?? LEARNING_INTERVAL_MS;
    this.now = deps.now ?? (() => Date.now());
  }

  getConfig(): LearningConfig {
    const raw = this.deps.settings.resolve(LEARNING_CONFIG_KEY);
    if (raw === NO_VALUE || raw === null || typeof raw !== 'object') return { ...DEFAULT_LEARNING_CONFIG };
    const v = raw as Partial<LearningConfig>;
    return {
      enabled: v.enabled !== false,
      mode: v.mode === 'auto' ? 'auto' : 'manual',
      ...(typeof v.analyzerAgentId === 'string' && AGENT_ID.test(v.analyzerAgentId) ? { analyzerAgentId: v.analyzerAgentId } : {}),
      ...(typeof v.analyzerModel === 'string' && MODEL_ID.test(v.analyzerModel) ? { analyzerModel: v.analyzerModel } : {}),
      intervalMs: this.intervalMs,
    };
  }

  /** Saving an analyzerAgentId is the user's approval of that LLM. */
  setConfig(input: { enabled?: boolean | undefined; mode?: LearningConfig['mode'] | undefined; analyzerAgentId?: string | undefined; analyzerModel?: string | undefined }): LearningConfig {
    const current = this.getConfig();
    const next: LearningConfig = {
      enabled: input.enabled ?? current.enabled,
      mode: input.mode === 'auto' || input.mode === 'manual' ? input.mode : current.mode,
      intervalMs: this.intervalMs,
    };
    const agentId = input.analyzerAgentId !== undefined ? input.analyzerAgentId : current.analyzerAgentId;
    if (agentId !== undefined && agentId !== '') {
      if (!AGENT_ID.test(agentId)) throw new Error('Invalid analyzer agent id');
      if (!this.deps.availableAgents().includes(agentId)) throw new Error(`Agent ${agentId} is not available to approve as the learning LLM`);
      next.analyzerAgentId = agentId;
    }
    const model = input.analyzerModel !== undefined ? input.analyzerModel : current.analyzerModel;
    if (model !== undefined && model !== '') {
      if (!MODEL_ID.test(model)) throw new Error('Invalid analyzer model');
      next.analyzerModel = model;
    }
    this.deps.settings.set({ key: LEARNING_CONFIG_KEY, value: next, scope: 'global' });
    // Approvals made under a different analyzer LLM/model are stale: purge
    // pending + approved routing rules so the new analyzer starts clean.
    const prevIdentity = current.analyzerAgentId !== undefined ? `${current.analyzerAgentId}:${current.analyzerModel ?? ''}` : undefined;
    const nextIdentity = next.analyzerAgentId !== undefined ? `${next.analyzerAgentId}:${next.analyzerModel ?? ''}` : undefined;
    const purged = prevIdentity !== undefined && nextIdentity !== undefined && prevIdentity !== nextIdentity
      ? this.deps.engine.purgeRoutingApprovals('user')
      : { removed: 0, removedIds: [] as string[] };
    this.deps.audit.append({
      actor: 'user', action: 'learning_config_updated',
      redactedPayload: { enabled: next.enabled, mode: next.mode, analyzerAgentId: next.analyzerAgentId ?? null, analyzerModel: next.analyzerModel ?? null, intervalMs: next.intervalMs, purgedRoutingApprovals: purged.removed },
    });
    this.reschedule();
    return next;
  }

  /** Delete pending + approved routing rules (old routing approvals). */
  purgeRoutingApprovals(): { removed: number; removedIds: string[] } {
    return this.deps.engine.purgeRoutingApprovals('user');
  }

  getStatus(): LearningStatus {
    const last = this.deps.settings.resolve(LEARNING_LAST_RUN_KEY);
    return {
      config: this.getConfig(),
      running: this.inFlight !== undefined,
      ...(last !== NO_VALUE && last !== null && typeof last === 'object' ? { lastRun: last as LearningRun } : {}),
      ...(this.nextRunAt !== undefined && this.timer !== undefined ? { nextRunAt: this.nextRunAt } : {}),
    };
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.reschedule();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.nextRunAt = undefined;
  }

  /** One learning cycle. Concurrent calls share the in-flight run. */
  runNow(trigger: 'cron' | 'manual' = 'manual'): Promise<LearningRun> {
    if (this.inFlight !== undefined) return this.inFlight;
    const run = this.execute(trigger).finally(() => { if (this.inFlight === run) this.inFlight = undefined; });
    this.inFlight = run;
    return run;
  }

  private reschedule(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.nextRunAt = undefined;
    if (!this.getConfig().enabled) return;
    this.nextRunAt = new Date(this.now() + this.intervalMs).toISOString();
    this.timer = setInterval(() => { void this.runNow('cron').catch(() => undefined); }, this.intervalMs);
    this.timer.unref?.();
  }

  private async execute(trigger: 'cron' | 'manual'): Promise<LearningRun> {
    const startedAt = new Date(this.now()).toISOString();
    const config = this.getConfig();
    const outcomeCount = this.deps.learningLoop.outcomeCount();
    const base: LearningRun = { id: randomUUID(), trigger, status: 'skipped', startedAt, proposalIds: [], autoApprovedIds: [], outcomeCount, ...(config.analyzerAgentId !== undefined ? { analyzerAgentId: config.analyzerAgentId } : {}) };
    const finish = (run: LearningRun): LearningRun => {
      const done = { ...run, finishedAt: new Date(this.now()).toISOString() };
      try {
        this.deps.settings.set({ key: LEARNING_LAST_RUN_KEY, value: done, scope: 'global' });
        this.deps.audit.append({ actor: 'orchestrator', action: `learning_run_${done.status}`, target: done.id, redactedPayload: { trigger, reason: done.reason ?? null, proposalIds: done.proposalIds, autoApprovedIds: done.autoApprovedIds, outcomeCount } });
      } catch { /* a bookkeeping failure must not mask the run result */ }
      if (trigger === 'cron') this.reschedule();
      return done;
    };

    if (trigger === 'cron' && !config.enabled) return finish({ ...base, reason: 'disabled', detail: 'Learning cron is off.' });
    if (config.analyzerAgentId === undefined) return finish({ ...base, reason: 'no_approved_llm', detail: 'Approve an LLM for learning before analysis can run.' });
    if (!this.deps.availableAgents().includes(config.analyzerAgentId)) return finish({ ...base, reason: 'analyzer_unavailable', detail: `Approved learning LLM ${config.analyzerAgentId} is not available.` });
    const statsByKey = this.deps.learningLoop.allAgentStats().filter((s) => s.agents.length > 0);
    if (statsByKey.length === 0) return finish({ ...base, reason: 'no_outcomes', detail: 'No finished tasks recorded yet.' });
    const previous = this.getStatus().lastRun;
    if (trigger === 'cron' && previous !== undefined && previous.outcomeCount >= outcomeCount && previous.status !== 'failed') {
      return finish({ ...base, reason: 'no_new_data', detail: 'No new task outcomes since the last learning run.' });
    }

    try {
      const suggestions = await this.deps.analyzer.analyze({
        analyzerAgentId: config.analyzerAgentId,
        ...(config.analyzerModel !== undefined ? { analyzerModel: config.analyzerModel } : {}),
        statsByKey,
        recentLogs: this.deps.audit.recent(100).map(({ actor, action, target, createdAt }) => ({ actor, action, ...(target !== undefined ? { target } : {}), createdAt })),
        availableAgents: this.deps.availableAgents(),
      });
      const proposalIds: string[] = [];
      const autoApprovedIds: string[] = [];
      for (const suggestion of suggestions) {
        const keyStats = statsByKey.find((s) => s.comparabilityKey === suggestion.comparabilityKey);
        if (keyStats === undefined) continue;
        const ranked = keyStats.agents.filter((a) => a.stats.sampleSize >= MIN_AGENT_SAMPLES)
          .sort((a, b) => a.stats.failureRate - b.stats.failureRate || a.stats.meanDurationMs - b.stats.meanDurationMs);
        const winner = ranked[0];
        // The LLM proposes; the evidence disposes. A suggestion to prefer
        // anyone but the measured winner is dropped, never proposed.
        if (winner === undefined || winner.adapterId !== suggestion.preferAdapterId) continue;
        const alreadyOpen = this.deps.engine.listProposals().some((p) => (p.status === 'proposed' || p.status === 'approved')
          && p.kind === 'routing_rule' && p.comparabilityKey === suggestion.comparabilityKey
          && (p.payload as { preferAdapterId?: unknown } | null)?.preferAdapterId === suggestion.preferAdapterId);
        if (alreadyOpen) continue;
        const totalSamples = keyStats.agents.reduce((n, a) => n + a.stats.sampleSize, 0);
        if (totalSamples < MIN_IMPROVEMENT_EXAMPLES) continue;
        const evaluation = this.deps.engine.evaluate({
          comparabilityKey: suggestion.comparabilityKey,
          kind: 'routing_rule',
          summary: suggestion.summary,
          payload: { capability: suggestion.capability, preferAdapterId: suggestion.preferAdapterId },
        }, winner.stats);
        if (evaluation.classification !== 'demonstrated') continue;
        proposalIds.push(evaluation.proposal.id);
        if (config.mode === 'auto') {
          this.deps.engine.approve(evaluation.proposal.id);
          autoApprovedIds.push(evaluation.proposal.id);
          this.deps.audit.append({ actor: 'orchestrator', action: 'learning_auto_approved', target: evaluation.proposal.id, redactedPayload: { comparabilityKey: suggestion.comparabilityKey, preferAdapterId: suggestion.preferAdapterId, analyzerAgentId: config.analyzerAgentId } });
        }
      }
      return finish({ ...base, status: 'completed', proposalIds, autoApprovedIds, detail: proposalIds.length === 0 ? 'Analysis complete; no demonstrated routing change.' : `Created ${proposalIds.length} routing proposal${proposalIds.length === 1 ? '' : 's'}${autoApprovedIds.length > 0 ? `, auto-approved ${autoApprovedIds.length}` : ''}.` });
    } catch (error) {
      return finish({ ...base, status: 'failed', reason: 'analyzer_failed', detail: error instanceof Error ? error.message.slice(0, 500) : 'Learning LLM failed' });
    }
  }
}
