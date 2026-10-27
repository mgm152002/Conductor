// Token usage views shared by main and renderer.

export type UsageRange = '24h' | '7d' | '30d' | '90d' | 'all';

/** The two quota windows agent CLIs report. */
export type UsageLimitWindowKind = 'session' | 'weekly';

/**
 * The latest quota snapshot reported by one CLI for one window kind.
 *
 * Percentages are optional on purpose: a missing value means the CLI did not
 * report that number, which the renderer must show as "not reported" rather
 * than as 0 percent. A reported 0 is a real value (the window is exhausted).
 */
export interface UsageLimitWindow {
  kind: UsageLimitWindowKind;
  /** Percentage of the window still available, 0–100. */
  remainingPercent?: number;
  /** Percentage of the window already consumed, 0–100. */
  usedPercent?: number;
  /** ISO timestamp when the window resets, when the CLI reports it. */
  resetsAt?: string;
  /** ISO timestamp of the sample this row was last updated from. */
  reportedAt?: string;
  /** Which source produced the sample (CLI/adapter id, e.g. 'codex'). */
  source?: string;
  /**
   * Optional provider label for the window, when a CLI splits one kind into
   * separate quotas (for example Antigravity's model groups).
   */
  label?: string;
  /** Total length of the window in minutes, when the CLI reports it. */
  windowMinutes?: number;
}

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

/**
 * One attached agent CLI and its usage for the selected range. The usage
 * fields are flattened (a `UsageRow`) so a zero-usage client is just a row
 * with zeros; `limits` holds at most one entry per window kind.
 */
export interface UsageClient extends UsageRow {
  /** Latest quota samples; empty when the CLI does not report limits. */
  limits: UsageLimitWindow[];
}

export interface UsageSummary {
  range: UsageRange;
  totals: UsageRow;
  byAgent: UsageRow[];
  byProject: UsageRow[];
  byModel: UsageRow[];
  /** Every attached CLI, including ones with zero usage in this range. */
  clients: UsageClient[];
}

export interface TaskUsage {
  total: UsageRow | null;
  /** Keyed by step id; the planner session is keyed 'planner'. */
  byStep: Record<string, UsageRow>;
}
