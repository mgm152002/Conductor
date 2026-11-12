import type { UsageRange, UsageSummary } from '@shared/usage';
import { compactNumber, formatCost, rangeLabel } from '../../lib/usage-format';
import { UsageTokenMix } from './UsageBars';
import {
  UsageBreakdownTable,
  UsageClientCard,
  UsageMetric,
} from './UsageBreakdownTable';

// The Cost view (Requirement 2.2). For the selected range it shows the
// estimated cost across sessions, the token mix behind it, one compact card
// per attached CLI (including CLIs with no usage), and the by-agent /
// by-project / by-model breakdowns.
//
// Cost is estimated from recorded tokens at each model's public models.dev
// price; harness-reported cost is never used. A model with no published
// price has no estimate, shown as "No public pricing" rather than $0.

export interface UsageCostViewProps {
  summary: UsageSummary;
  range?: UsageRange;
  loading?: boolean;
}

export function UsageCostView({
  summary,
  range = summary.range,
  loading = false,
}: UsageCostViewProps): React.JSX.Element {
  const { totals, clients } = summary;
  const totalCost = totals.costUsd !== undefined ? formatCost(totals.costUsd) : 'No public pricing';
  const costPriced = clients.some((client) => client.costUsd !== undefined);
  const costBase = clients.reduce((sum, client) => sum + (client.costUsd ?? 0), 0);

  return (
    <section className="flex flex-col gap-6" aria-label="Cost usage">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className="group-card flex flex-col justify-between gap-5 p-5">
          <div>
            <p className="text-2xs font-medium text-muted-foreground">Estimated cost</p>
            <p className="mt-1 font-display text-[40px] leading-none font-semibold text-foreground tabular-nums">{totalCost}</p>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {totals.sessions} sessions · {rangeLabel(range)}{costPriced ? ' · estimated at public models.dev prices' : ' · no public pricing for the models used'}
          {loading ? <span role="status" aria-live="polite"> · Refreshing…</span> : null}
        </p>
          </div>
          <UsageTokenMix totals={totals} />
        </div>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
          <UsageMetric label="Processed tokens" value={compactNumber(totals.totalTokens)} />
        <UsageMetric label="Agent sessions" value={String(totals.sessions)} />
        <UsageMetric label="Total tokens" value={compactNumber(totals.totalTokens)} />
        </dl>
      </div>

      <section className="flex flex-col" aria-label="Cost by CLI">
        <header className="mb-2 flex items-baseline gap-2">
          <h3 className="text-xs font-semibold text-muted-foreground">By CLI</h3>
          <span className="text-3xs text-muted-foreground/80">
            {costPriced ? 'Share of estimated cost' : 'Share of tokens'}
          </span>
        </header>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {clients.map((client) => (
            <UsageClientCard
              key={client.key}
              client={client}
              primaryLabel="Cost"
              primaryValue={client.costUsd !== undefined ? formatCost(client.costUsd) : 'No public pricing'}
              primaryHint={client.costUsd === undefined && client.totalTokens > 0 ? 'No public pricing for the model used' : undefined}
              sharePercent={costPriced && costBase > 0
                ? ((client.costUsd ?? 0) / costBase) * 100
                : totals.totalTokens > 0
                  ? (client.totalTokens / totals.totalTokens) * 100
                  : 0}
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
