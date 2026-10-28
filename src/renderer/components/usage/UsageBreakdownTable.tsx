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
      className="flex flex-col gap-2 border-b border-border py-3.5 last:border-b-0"
    >
      <header className="flex items-center gap-2">
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-primary/80" />
        <h4 className="truncate text-sm font-medium text-foreground">{clientLabel(client)}</h4>
        <span className="text-3xs text-muted-foreground">{client.sessions} session{client.sessions === 1 ? '' : 's'}</span>
        {empty ? <Badge className="ml-auto">No usage</Badge> : null}
        <span className={cn('ml-auto font-medium text-foreground tabular-nums', empty ? 'text-sm' : 'text-base')}>
          {primaryValue}
        </span>
      </header>

      <div className="flex items-baseline gap-2 pl-4">
        <span className="text-2xs text-muted-foreground">{primaryLabel} · {percent}% of total</span>
      </div>

      <div className="ml-4 h-[3px] w-auto overflow-hidden rounded-full bg-muted">
        {empty ? null : (
          <div className="h-full rounded-full bg-foreground/70" style={{ width: `${Math.max(2, percent)}%` }} />
        )}
      </div>

      <p className="pl-4 text-3xs text-muted-foreground">
        {compactNumber(client.inputTokens)} input
        {' · '}{compactNumber(client.outputTokens)} output
        {client.cachedInputTokens > 0 ? ` · ${compactNumber(client.cachedInputTokens)} cached` : ''}
        {client.reasoningTokens > 0 ? ` · ${compactNumber(client.reasoningTokens)} reasoning` : ''}
      </p>
      {primaryHint !== undefined ? (
        <p className="pl-4 text-3xs text-muted-foreground/80">{primaryHint}</p>
      ) : null}

      {empty ? (
        <p className="pl-4 text-3xs text-muted-foreground">
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
    <div className="py-1">
      <dt className="text-2xs text-muted-foreground">{label}</dt>
      <dd
        className={
          emphasis
            ? 'mt-0.5 text-xl font-medium text-foreground tabular-nums'
            : 'mt-0.5 text-base font-medium text-foreground tabular-nums'
        }
      >
        {value}
      </dd>
      {hint !== undefined ? <p className="mt-0.5 text-3xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
