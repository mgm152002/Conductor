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
      <div>
        <p className="text-4xl font-medium tracking-tight text-foreground tabular-nums">{compactNumber(totals.totalTokens)}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {totals.sessions} sessions · {rangeLabel(range)}
          {loading ? <span role="status" aria-live="polite"> · Refreshing…</span> : null}
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 border-y border-border py-3 sm:grid-cols-3">
        <UsageMetric label="Processed tokens" value={compactNumber(totals.totalTokens)} />
        <UsageMetric label="Agent sessions" value={String(totals.sessions)} />
        <UsageMetric
          label="Total cost"
          value={totals.costUsd !== undefined ? formatCost(totals.costUsd) : 'Not reported'}
        />
      </dl>

      <UsageTokenMix totals={totals} />

      <section className="flex flex-col" aria-label="Tokens by CLI">
        <header className="flex items-baseline gap-2">
          <h3 className="text-[13px] font-medium text-foreground">By CLI</h3>
          <span className="text-3xs text-muted-foreground/80">Share of tokens</span>
        </header>
        <div className="flex flex-col">
          {clients.map((client) => (
            <UsageClientCard
              key={client.key}
              client={client}
              primaryLabel="Tokens"
              primaryValue={compactNumber(client.totalTokens)}
              primaryHint={client.costUsd !== undefined ? `${formatCost(client.costUsd)} reported` : undefined}
              sharePercent={totals.totalTokens > 0 ? (client.totalTokens / totals.totalTokens) * 100 : 0}
            />
          ))}
        </div>
      </section>

      <UsageBreakdownTable title="By agent" rows={summary.byAgent} />
      <div className="grid gap-4 lg:grid-cols-2">
        <UsageBreakdownTable title="By project" rows={summary.byProject} />
        <UsageBreakdownTable title="By model" rows={summary.byModel} />
      </div>
    </section>
  );
}
