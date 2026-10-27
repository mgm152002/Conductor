import type { UsageClient, UsageRow } from '@shared/usage';
import { clientLabel, compactNumber, formatCost } from '../../lib/usage-format';
import { cn } from '../../lib/cn';
import { Badge } from '../ui/primitives';
import { UsageBarGroup } from './UsageBars';

// The by-agent / by-project / by-model breakdowns shared by the Cost and Tokens
// views. Rendered as grouped bar lists rather than tables: same values, far
// less visual noise, and each row's share of the group is obvious at a glance.
// The Cost column appears only when at least one row reports cost.

export function UsageBreakdownTable({
  title,
  rows,
}: {
  title: string;
  rows: UsageRow[];
}): React.JSX.Element | null {
  if (rows.length === 0) return null;
  const anyCost = rows.some((row) => row.costUsd !== undefined);

  return (
    <UsageBarGroup
      title={title}
      description="Share of tokens"
      rows={rows.map((row) => ({
        key: row.key,
        label: row.label,
        value: row.totalTokens,
        display: compactNumber(row.totalTokens),
        ...(anyCost && row.costUsd !== undefined ? { cost: formatCost(row.costUsd) } : {}),
        detail: `${row.sessions} session${row.sessions === 1 ? '' : 's'} · ${compactNumber(row.inputTokens)} in · ${compactNumber(row.outputTokens)} out`,
      }))}
    />
  );
}

/**
 * One attached CLI's usage for the selected range. Every attached CLI renders,
 * even with no sessions: the zero case is called out explicitly instead of
 * disappearing from the breakdown (Requirement 2.4).
 */
export function UsageClientCard({
  client,
  primaryLabel,
  primaryValue,
  primaryHint,
  sharePercent = 0,
}: {
  client: UsageClient;
  primaryLabel: string;
  primaryValue: string;
  primaryHint?: string | undefined;
  /** Share of the group total, used for the compact comparison bar. */
  sharePercent?: number;
}): React.JSX.Element {
  const empty = client.sessions === 0
    && client.totalTokens === 0
    && (client.costUsd === undefined || client.costUsd === 0);
  const percent = Math.min(100, Math.max(0, Math.round(sharePercent)));

  return (
    <article
      aria-label={`${clientLabel(client)} usage`}
      className="flex flex-col gap-2.5 rounded-xl border border-border px-4 py-3"
    >
      <header className="flex items-center gap-2">
        <h4 className="truncate text-sm font-medium text-foreground">{clientLabel(client)}</h4>
        <span className="text-3xs text-muted-foreground">{client.key}</span>
        {empty ? <Badge className="ml-auto">No usage</Badge> : null}
      </header>

      <div className="flex items-baseline gap-2">
        <span className={cn('font-semibold text-foreground tabular-nums', empty ? 'text-lg' : 'text-2xl')}>
          {primaryValue}
        </span>
        <span className="text-2xs text-muted-foreground">{primaryLabel}</span>
        <span className="ml-auto text-3xs text-muted-foreground tabular-nums">{percent}%</span>
      </div>

      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/70">
        {empty ? (
          <div className="h-full w-full rounded-full border border-dashed border-border/80" />
        ) : (
          <div className="h-full rounded-full bg-primary/80" style={{ width: `${Math.max(2, percent)}%` }} />
        )}
      </div>

      <p className="text-3xs text-muted-foreground">
        {client.sessions} session{client.sessions === 1 ? '' : 's'} · {compactNumber(client.inputTokens)} input
        {' · '}{compactNumber(client.outputTokens)} output
        {client.cachedInputTokens > 0 ? ` · ${compactNumber(client.cachedInputTokens)} cached` : ''}
        {client.reasoningTokens > 0 ? ` · ${compactNumber(client.reasoningTokens)} reasoning` : ''}
      </p>
      {primaryHint !== undefined ? (
        <p className="text-3xs text-muted-foreground/80">{primaryHint}</p>
      ) : null}

      {empty ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-2 text-center text-3xs text-muted-foreground">
          No usage recorded for this CLI in the selected range.
        </p>
      ) : null}
    </article>
  );
}

/** One summary metric tile, e.g. "Total tokens" / "12.3k". */
export function UsageMetric({
  label,
  value,
  hint,
  emphasis = false,
}: {
  label: string;
  value: string;
  hint?: string | undefined;
  emphasis?: boolean;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border px-3 py-2">
      <dt className="text-3xs text-muted-foreground uppercase">{label}</dt>
      <dd
        className={
          emphasis
            ? 'text-lg font-semibold text-foreground tabular-nums'
            : 'text-sm font-semibold text-foreground tabular-nums'
        }
      >
        {value}
      </dd>
      {hint !== undefined ? <p className="text-3xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
