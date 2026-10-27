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
    <section className="flex flex-col gap-5" aria-label="Token usage">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-semibold text-foreground">Tokens</h2>
        <span className="text-xs text-muted-foreground">{rangeLabel(range)}</span>
        {loading ? (
          <span role="status" aria-live="polite" className="ml-auto text-3xs text-muted-foreground">
            Refreshing…
          </span>
        ) : null}
      </div>

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <UsageMetric label="Total tokens" value={compactNumber(totals.totalTokens)} emphasis />
        <UsageMetric label="Agent sessions" value={String(totals.sessions)} />
        <UsageMetric
          label="Total cost"
          value={totals.costUsd !== undefined ? formatCost(totals.costUsd) : 'Not reported'}
        />
      </dl>

      <UsageTokenMix totals={totals} />

      <section className="flex flex-col gap-2" aria-label="Tokens by CLI">
        <header className="flex items-baseline gap-2">
          <h3 className="text-xs font-medium text-muted-foreground">By CLI</h3>
          <span className="text-3xs text-muted-foreground/80">Share of tokens</span>
        </header>
        <div className="grid gap-3 lg:grid-cols-2">
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
