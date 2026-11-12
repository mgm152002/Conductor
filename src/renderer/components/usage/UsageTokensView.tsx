import type { UsageRange, UsageSummary } from '@shared/usage';
import { compactNumber, formatCost, rangeLabel } from '../../lib/usage-format';
import { UsageTokenMix } from './UsageBars';
import {
  UsageBreakdownTable,
  UsageClientCard,
  UsageMetric,
} from './UsageBreakdownTable';

// The Tokens view (Requirement 2.2). Same shape as the Cost view, but the
// headline metric is total tokens: the range totals, a compact card for every
// attached CLI (zero-usage included, Requirement 2.4), then the by-agent,
// by-project, and by-model bar breakdowns.

export interface UsageTokensViewProps {
  summary: UsageSummary;
  range?: UsageRange;
  loading?: boolean;
}

export function UsageTokensView({
  summary,
  range = summary.range,
  loading = false,
}: UsageTokensViewProps): React.JSX.Element {
  const { totals, clients } = summary;

  return (
    <section className="flex flex-col gap-6" aria-label="Token usage">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className="group-card flex flex-col justify-between gap-5 p-5">
          <div>
            <p className="text-2xs font-medium text-muted-foreground">Total tokens</p>
            <p className="mt-1 font-display text-[40px] leading-none font-semibold text-foreground tabular-nums">{compactNumber(totals.totalTokens)}</p>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {totals.sessions} sessions · {rangeLabel(range)}
          {loading ? <span role="status" aria-live="polite"> · Refreshing…</span> : null}
        </p>
          </div>
          <UsageTokenMix totals={totals} />
        </div>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
          <UsageMetric label="Processed tokens" value={compactNumber(totals.totalTokens)} />
        <UsageMetric label="Agent sessions" value={String(totals.sessions)} />
        <UsageMetric
          label="Total cost"
          value={totals.costUsd !== undefined ? formatCost(totals.costUsd) : 'No public pricing'}
        />
        </dl>
      </div>

      <section className="flex flex-col" aria-label="Tokens by CLI">
        <header className="mb-2 flex items-baseline gap-2">
          <h3 className="text-xs font-semibold text-muted-foreground">By CLI</h3>
          <span className="text-3xs text-muted-foreground/80">Share of tokens</span>
        </header>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {clients.map((client) => (
            <UsageClientCard
              key={client.key}
              client={client}
              primaryLabel="Tokens"
              primaryValue={compactNumber(client.totalTokens)}
              primaryHint={client.costUsd !== undefined ? `${formatCost(client.costUsd)} estimated` : undefined}
              sharePercent={totals.totalTokens > 0 ? (client.totalTokens / totals.totalTokens) * 100 : 0}
            />
          ))}
        </div>
      </section>

      <div className="grid items-start gap-3 lg:grid-cols-3">
        <UsageBreakdownTable title="By agent" rows={summary.byAgent} />
        <UsageBreakdownTable title="By project" rows={summary.byProject} />
        <UsageBreakdownTable title="By model" rows={summary.byModel} />
      </div>
    </section>
  );
}
