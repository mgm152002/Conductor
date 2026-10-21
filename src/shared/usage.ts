// Token usage views shared by main and renderer.

export type UsageRange = '7d' | '30d' | 'all';

export interface UsageRow {
  key: string;
  label: string;
  sessions: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  /** Only when the agent reported a cost (Claude Code, some ACP agents). */
  costUsd?: number;
}

export interface UsageSummary {
  range: UsageRange;
  totals: UsageRow;
  byAgent: UsageRow[];
  byProject: UsageRow[];
  byModel: UsageRow[];
}

export interface TaskUsage {
  total: UsageRow | null;
  /** Keyed by step id; the planner session is keyed 'planner'. */
  byStep: Record<string, UsageRow>;
}
