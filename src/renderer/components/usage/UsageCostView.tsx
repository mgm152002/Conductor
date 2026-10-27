import type { UsageRange, UsageSummary } from '@shared/usage';
import { compactNumber, formatCost, rangeLabel } from '../../lib/usage-format';
import { UsageTokenMix } from './UsageBars';
import {
  UsageBreakdownTable,
  UsageClientCard,
  UsageMetric,
} from './UsageBreakdownTable';

// The Cost view (Requirement 2.2). For the selected range it shows the money
// reported across sessions, the token mix behind it, one compact card per
// attached CLI (including CLIs with no usage), and the by-agent / by-project /
// by-model breakdowns.
//
// Cost is optional because only some CLIs report it (Claude Code does; Codex
// does not), so a missing total is shown as "Not reported" rather than $0.

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
  const totalCost = totals.costUsd !== undefined ? formatCost(totals.costUsd) : 'Not reported';
  const costReported = clients.some((client) => client.costUsd !== undefined);
  const costBase = clients.reduce((sum, client) => sum + (client.costUsd ?? 0), 0);

  return (
    <section className="flex flex-col gap-5" aria-label="Cost usage">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-semibold text-foreground">Cost</h2>
        <span className="text-xs text-muted-foreground">{rangeLabel(range)}</span>
        {loading ? (
          <span role="status" aria-live="polite" className="ml-auto text-3xs text-muted-foreground">
            Refreshing…
          </span>
        ) : null}
      </div>

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <UsageMetric
          label="Total cost"
          value={totalCost}
          hint={costReported ? 'Reported by attached CLIs' : 'No CLI reported cost'}
          emphasis
        />
        <UsageMetric label="Agent sessions" value={String(totals.sessions)} />
        <UsageMetric label="Total tokens" value={compactNumber(totals.totalTokens)} />
      </dl>

      <UsageTokenMix totals={totals} />

      <section className="flex flex-col gap-2" aria-label="Cost by CLI">
        <header className="flex items-baseline gap-2">
          <h3 className="text-xs font-medium text-muted-foreground">By CLI</h3>
          <span className="text-3xs text-muted-foreground/80">
            {costReported ? 'Share of reported cost' : 'Share of tokens'}
          </span>
        </header>
        <div className="grid gap-3 lg:grid-cols-2">
          {clients.map((client) => (
            <UsageClientCard
              key={client.key}
              client={client}
              primaryLabel="Cost"
              primaryValue={client.costUsd !== undefined ? formatCost(client.costUsd) : 'Not reported'}
              primaryHint={client.costUsd === undefined ? 'Cost not reported by this CLI' : undefined}
              sharePercent={costReported && costBase > 0
                ? ((client.costUsd ?? 0) / costBase) * 100
                : totals.totalTokens > 0
                  ? (client.totalTokens / totals.totalTokens) * 100
                  : 0}
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
