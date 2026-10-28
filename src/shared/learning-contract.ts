import type { PerformanceBaseline } from './domain';

// Learning tab contracts: a user-approved LLM periodically (every 5 minutes)
// reviews per-agent logs and success rates and suggests agent routing. In
// `manual` mode each suggestion stays a proposal until the user approves it;
// in `auto` mode demonstrated suggestions are approved automatically. The
// deterministic SelfLearningEngine gate still decides what is demonstrated,
// so an LLM can never adopt a routing that the measured evidence refutes.

/** How often the learning cron runs. */
export const LEARNING_INTERVAL_MS = 5 * 60_000;

export type LearningApprovalMode = 'manual' | 'auto';

export interface LearningConfig {
  /** Master switch for the 5-minute cron. Manual "Run now" ignores it. */
  enabled: boolean;
  mode: LearningApprovalMode;
  /** Agent (adapter id) the user approved to act as the analyzing LLM. */
  analyzerAgentId?: string;
  /** Optional model for the analyzer agent; omitted means its default/Auto. */
  analyzerModel?: string;
  intervalMs: number;
}

export const DEFAULT_LEARNING_CONFIG: LearningConfig = {
  enabled: true,
  mode: 'manual',
  intervalMs: LEARNING_INTERVAL_MS,
};

export type LearningRunStatus = 'completed' | 'skipped' | 'failed';
export type LearningRunTrigger = 'cron' | 'manual';

export interface LearningRun {
  id: string;
  trigger: LearningRunTrigger;
  status: LearningRunStatus;
  startedAt: string;
  finishedAt?: string;
  analyzerAgentId?: string;
  /** Machine-readable skip/failure reason, e.g. `no_approved_llm`. */
  reason?: string;
  /** Human-readable detail for the Learning tab. */
  detail?: string;
  /** Proposals created by this run (proposed in manual mode). */
  proposalIds: string[];
  /** Proposals this run approved itself (auto mode only). */
  autoApprovedIds: string[];
  /** Task outcomes considered; cron skips when this has not grown. */
  outcomeCount: number;
}

export interface LearningStatus {
  config: LearningConfig;
  running: boolean;
  lastRun?: LearningRun;
  nextRunAt?: string;
}

/** Result of purging old (pending + approved) routing-rule proposals. */
export interface RoutingPurgeResult {
  removed: number;
  removedIds: string[];
}

/** Per-agent success evidence for one comparability key, fed to the LLM. */
export interface AgentStatsByKey {
  comparabilityKey: string;
  agents: { adapterId: string; stats: PerformanceBaseline }[];
}
