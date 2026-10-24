import type { UsageRow } from '@shared/usage';

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
