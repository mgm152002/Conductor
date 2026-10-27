import type { UsageClient, UsageLimitWindow, UsageRange, UsageRow } from '@shared/usage';

/** 950 → "950", 12_300 → "12.3k", 4_200_000 → "4.2M". */
export function compactNumber(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

export function formatCost(usd: number): string {
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;
}

/** "12.3k tokens · $0.04" */
export function usageLabel(row: UsageRow): string {
  return [`${compactNumber(row.totalTokens)} tokens`, ...(row.costUsd !== undefined ? [formatCost(row.costUsd)] : [])].join(' · ');
}

/** Output tokens per second over a task's wall-clock duration, if measurable. */
export function outputRate(row: UsageRow, durationMs: number | undefined): number | undefined {
  if (durationMs === undefined || durationMs <= 0 || row.outputTokens <= 0) return undefined;
  return row.outputTokens / (durationMs / 1000);
}

/** "12.3k in · 4.2k out · 58 tok/s" */
export function usageBreakdown(row: UsageRow, durationMs?: number): string {
  const rate = outputRate(row, durationMs);
  return [
    `${compactNumber(row.inputTokens)} in`,
    `${compactNumber(row.outputTokens)} out`,
    ...(rate !== undefined ? [`${compactNumber(Math.round(rate))} tok/s`] : []),
  ].join(' · ');
}

const AGENT_NAMES: Record<string, string> = {
  codex: 'Codex', 'claude-code': 'Claude Code', opencode: 'OpenCode', antigravity: 'Antigravity', kiro: 'Kiro',
};

/** A short display name for an agent (adapter) id. */
export function agentLabel(id: string | undefined): string {
  if (id === undefined) return 'No agent';
  if (id.startsWith('remote:')) return `Remote ${id.slice('remote:'.length)}`;
  return AGENT_NAMES[id] ?? id;
}

/** The usage ranges offered by the Usage screen, with their chip labels. */
export const USAGE_RANGES: { id: UsageRange; label: string }[] = [
  { id: '24h', label: 'Past 24h' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
  { id: 'all', label: 'All time' },
];

/** The visible label for a usage range ("Past 24h", "7 days", "All time"). */
export function rangeLabel(range: UsageRange): string {
  return USAGE_RANGES.find((entry) => entry.id === range)?.label
    ?? (range === 'all' ? 'All time' : range);
}

/**
 * The percentage of a quota window left, from whichever side the CLI reported.
 * A missing percentage is `undefined` (not zero) so callers can show
 * "Not reported" rather than inventing an exhausted window.
 */
export function percentLeft(
  limit: Pick<UsageLimitWindow, 'remainingPercent' | 'usedPercent'> | null | undefined,
): number | undefined {
  if (limit === null || limit === undefined) return undefined;
  const clamp = (value: number): number => Math.min(100, Math.max(0, Math.round(value)));
  if (typeof limit.remainingPercent === 'number' && Number.isFinite(limit.remainingPercent)) {
    return clamp(limit.remainingPercent);
  }
  if (typeof limit.usedPercent === 'number' && Number.isFinite(limit.usedPercent)) {
    return clamp(100 - limit.usedPercent);
  }
  return undefined;
}

/** "12%" for a reported window, "Not reported" when the CLI gave no percentage. */
export function formatPercentLeft(
  limit: Pick<UsageLimitWindow, 'remainingPercent' | 'usedPercent'> | null | undefined,
): string {
  const value = percentLeft(limit);
  return value === undefined ? 'Not reported' : `${value}%`;
}

/**
 * "5d 0h", "1h 3m", "12m", or "<1m" until a window resets. Accepts either the
 * ISO timestamp or a limit window carrying `resetsAt`. Returns `undefined` for
 * a missing/invalid timestamp or a window whose reset has already passed.
 */
export function resetCountdown(
  limit: string | Pick<UsageLimitWindow, 'resetsAt'> | null | undefined,
  now: Date | number = Date.now(),
): string | undefined {
  if (limit === null || limit === undefined) return undefined;
  const resetsAt = typeof limit === 'string' ? limit : limit.resetsAt;
  if (resetsAt === null || resetsAt === undefined) return undefined;
  const target = Date.parse(resetsAt);
  const current = typeof now === 'number' ? now : now.getTime();
  if (!Number.isFinite(target) || !Number.isFinite(current)) return undefined;
  const remainingMs = target - current;
  if (remainingMs <= 0) return undefined;
  const totalMinutes = Math.floor(remainingMs / 60_000);
  if (totalMinutes < 1) return '<1m';
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Alias kept readable at call sites that prefer an explicit verb. */
export const formatResetCountdown = resetCountdown;

/** A display name for an attached CLI, preferring its registry label. */
export function clientLabel(client: (Pick<UsageClient, 'key'> & { label?: string }) | string | undefined): string {
  if (client === undefined) return 'Unknown CLI';
  if (typeof client === 'string') return agentLabel(client);
  const label = client.label?.trim() ?? '';
  return label.length > 0 && label !== client.key ? label : agentLabel(client.key);
}
